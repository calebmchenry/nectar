import { Router, HttpError, parseLastEventId } from '../router.js';
import { createFiniteSseStream } from '../sse.js';
import { AnswerValue } from '../../interviewer/types.js';
import {
  PIPELINE_TERMINAL_EVENT_TYPES,
  type EventEnvelope,
  type PipelineCreateRequest,
} from '../types.js';
import { RunManager } from '../run-manager.js';
import { GraphRenderer } from '../graph-renderer.js';

export interface PipelineRoutesOptions {
  run_manager: RunManager;
  graph_renderer: GraphRenderer;
}

export function registerPipelineRoutes(router: Router, options: PipelineRoutesOptions): void {
  const runManager = options.run_manager;
  const graphRenderer = options.graph_renderer;

  router.register('POST', '/pipelines', async (ctx) => {
    const body = await ctx.readJson<PipelineCreateRequest>();
    const result = await runManager.startPipeline({
      dot_path: body.dot_path,
      dot_source: body.dot_source,
      auto_approve: body.auto_approve,
      launch_origin: 'pipeline_api',
    });
    ctx.sendJson(202, result);
  });

  router.register('GET', '/pipelines/:id', async (ctx) => {
    const status = await runManager.getStatus(ctx.params.id!);
    if (!status) {
      throw new HttpError(404, 'NOT_FOUND', `Run '${ctx.params.id}' not found.`);
    }
    ctx.sendJson(200, status);
  });

  router.register('GET', '/pipelines/:id/events', async (ctx) => {
    const runId = ctx.params.id!;
    const status = await runManager.getStatus(runId);
    if (!status) {
      throw new HttpError(404, 'NOT_FOUND', `Run '${runId}' not found.`);
    }

    const journal = await runManager.openJournal(runId);
    const lastEventIdRaw = ctx.req.headers['last-event-id'];
    const fromHeader = parseLastEventId(Array.isArray(lastEventIdRaw) ? lastEventIdRaw[0] : lastEventIdRaw);
    const fromQuery = parseLastEventId(ctx.query.get('last_event_id') ?? undefined);
    const fromSeq = Math.max(fromHeader, fromQuery);

    const stream = createFiniteSseStream({
      req: ctx.req,
      res: ctx.res,
      terminal_events: PIPELINE_TERMINAL_EVENT_TYPES,
    });

    let lastSentSeq = fromSeq;
    let replaying = true;
    const queuedLive: EventEnvelope[] = [];

    const sendEnvelope = (envelope: EventEnvelope) => {
      if (envelope.seq <= lastSentSeq || stream.isClosed()) {
        return;
      }
      const wrote = stream.send(envelope.event.type, envelope, envelope.seq);
      if (wrote) {
        lastSentSeq = envelope.seq;
      }
    };

    const unsubscribe = runManager.subscribe(runId, (envelope) => {
      if (replaying) {
        queuedLive.push(envelope);
        return;
      }
      sendEnvelope(envelope);
    });
    stream.onClose(() => {
      unsubscribe?.();
    });

    const replayCeiling = journal.currentSeq();
    await journal.replay({
      from_seq: fromSeq,
      on_envelope: async (envelope) => {
        if (stream.isClosed()) {
          return;
        }
        if (envelope.seq <= replayCeiling) {
          sendEnvelope(envelope);
        }
      },
    });

    replaying = false;
    queuedLive.sort((a, b) => a.seq - b.seq);
    for (const envelope of queuedLive) {
      if (stream.isClosed()) {
        break;
      }
      sendEnvelope(envelope);
    }

    if (stream.isClosed()) {
      return;
    }

    const latestStatus = await runManager.getStatus(runId);
    if (latestStatus && latestStatus.status !== 'running' && !stream.terminalEmitted()) {
      stream.close();
    }
  });

  router.register('POST', '/pipelines/:id/cancel', async (ctx) => {
    const status = await runManager.cancel(ctx.params.id!);
    ctx.sendJson(200, status);
  });

  router.register('POST', '/pipelines/:id/resume', async (ctx) => {
    const body = await ctx.readJson<{ auto_approve?: boolean; force?: boolean }>();
    const resumed = await runManager.resumePipeline({
      run_id: ctx.params.id!,
      auto_approve: body.auto_approve,
      force: body.force,
      launch_origin: 'pipeline_api',
    });
    ctx.sendJson(202, resumed);
  });

  router.register('GET', '/pipelines/:id/graph', async (ctx) => {
    const runId = ctx.params.id!;
    const dotSource = await runManager.readDotSource(runId);
    if (!dotSource) {
      throw new HttpError(404, 'NOT_FOUND', `Run '${runId}' not found.`);
    }

    const execution = await runManager.getGraphExecutionState(runId);
    const svg = await graphRenderer.render(dotSource, execution ?? undefined);
    ctx.sendText(200, svg, 'image/svg+xml; charset=utf-8');
  });

  router.register('GET', '/pipelines/:id/questions', async (ctx) => {
    const runId = ctx.params.id!;
    const questions = await runManager.getPendingQuestions(runId);
    ctx.sendJson(200, {
      run_id: runId,
      questions,
    });
  });

  router.register('POST', '/pipelines/:id/questions/:qid/answer', async (ctx) => {
    const body = await ctx.readJson<{
      answer?: string;
      selected_label?: string;
      selected_option?: number;
      text?: string;
      answer_value?: AnswerValue;
    }>();
    const selectedLabel = body.selected_label?.trim() || body.answer?.trim() || body.text?.trim();
    const hasSelectedOption = Number.isInteger(body.selected_option) && (body.selected_option as number) >= 0;
    if (!selectedLabel && !hasSelectedOption) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Answer must include selected_label or answer.');
    }

    const answered = await runManager.submitAnswer(ctx.params.id!, ctx.params.qid!, {
      selected_label: selectedLabel,
      selected_option: hasSelectedOption ? body.selected_option : undefined,
      answer_value: body.answer_value,
      text: body.text,
      source: 'user',
    });
    ctx.sendJson(200, {
      question_id: answered.question_id,
      status: answered.status,
      answer: answered.answer,
      answered_at: answered.answered_at,
    });
  });

  router.register('GET', '/pipelines/:id/checkpoint', async (ctx) => {
    const cocoon = await runManager.getCheckpoint(ctx.params.id!);
    if (!cocoon) {
      throw new HttpError(404, 'NOT_FOUND', `Run '${ctx.params.id}' not found.`);
    }
    ctx.sendJson(200, cocoon);
  });

  router.register('GET', '/pipelines/:id/context', async (ctx) => {
    const context = await runManager.getContext(ctx.params.id!);
    if (!context) {
      throw new HttpError(404, 'NOT_FOUND', `Run '${ctx.params.id}' not found.`);
    }
    ctx.sendJson(200, { context });
  });
}
