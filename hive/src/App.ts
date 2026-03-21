import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { DotEditor } from './components/DotEditor';
import { DraftComposer } from './components/DraftComposer';
import { GardenSidebar } from './components/GardenSidebar';
import { GraphPreview } from './components/GraphPreview';
import { QuestionTray } from './components/QuestionTray';
import { RunPanel } from './components/RunPanel';
import { SeedBoard } from './components/SeedBoard';
import { SeedComposer, type SeedComposerSubmitInput } from './components/SeedComposer';
import { SeedDetail } from './components/SeedDetail';
import { ViewNav, type HiveView } from './components/ViewNav';
import {
  api,
  ApiError,
  type EventEnvelope,
  type GardenSummary,
  type SeedPriority,
  type SeedStatus,
  type SeedSummary,
} from './lib/api';
import { DraftStreamer } from './lib/draft-stream';
import { RunStream } from './lib/run-stream';
import { WorkspaceStream, type WorkspaceEvent } from './lib/workspace-stream';

export class HiveApp {
  private readonly root: HTMLElement;

  private readonly viewNav: ViewNav;
  private readonly gardenLayout: HTMLElement;
  private readonly seedbedLayout: HTMLElement;

  private readonly sidebar: GardenSidebar;
  private readonly draftComposer: DraftComposer;
  private readonly editor: DotEditor;
  private readonly diagnostics: DiagnosticsPanel;
  private readonly preview: GraphPreview;
  private readonly runPanel: RunPanel;
  private readonly questionTray: QuestionTray;

  private readonly seedComposer: SeedComposer;
  private readonly seedBoard: SeedBoard;
  private readonly seedDetail: SeedDetail;

  private readonly draftStreamer: DraftStreamer;
  private readonly workspaceStream: WorkspaceStream;

  private viewMode: HiveView = 'gardens';

  private runStream: RunStream | null = null;
  private gardens: GardenSummary[] = [];
  private selectedGarden: string | null = null;
  private runId: string | null = null;
  private runStatus: 'idle' | 'running' | 'completed' | 'failed' | 'interrupted' = 'idle';
  private savedSource = '';

  private seeds: SeedSummary[] = [];
  private selectedSeedId: number | null = null;

  private previewTimer: number | null = null;
  private previewRequestSeq = 0;
  private previewAbort: AbortController | null = null;
  private lastValidPreviewSvg: string | null = null;
  private seedRefreshTimer: number | null = null;

  constructor(root: HTMLElement) {
    this.root = root;

    this.sidebar = new GardenSidebar({
      onSelect: (name) => {
        void this.loadGarden(name);
      },
    });

    this.draftComposer = new DraftComposer({
      onDraft: (prompt) => {
        this.startDraft(prompt);
      },
      onStop: () => {
        this.stopDraft();
      },
    });

    this.editor = new DotEditor({
      onChange: () => {
        this.handleEditorChange();
      },
      onSave: () => {
        void this.saveCurrentGarden();
      },
    });
    this.editor.setEnabled(false);

    this.diagnostics = new DiagnosticsPanel();
    this.preview = new GraphPreview();

    this.runPanel = new RunPanel({
      onStart: () => {
        void this.startRun();
      },
      onCancel: () => {
        void this.cancelRun();
      },
      onResume: () => {
        void this.resumeRun();
      },
    });

    this.questionTray = new QuestionTray({
      onAnswer: (questionId, selectedLabel) => {
        void this.answerQuestion(questionId, selectedLabel);
      },
    });

    this.seedComposer = new SeedComposer({
      onSubmit: (input) => {
        void this.createSeed(input);
      },
    });

    this.seedBoard = new SeedBoard({
      onSelect: (seedId) => {
        void this.selectSeed(seedId);
      },
      onDragStart: () => {
        // no-op
      },
      onMove: (seedId, nextStatus) => {
        void this.moveSeed(seedId, nextStatus);
      },
      onScroll: () => {
        this.syncUrl();
      },
    });

    this.seedDetail = new SeedDetail({
      onAnalyze: (seedId, force) => {
        void this.triggerSeedAnalysis(seedId, force);
      },
      onLinkGarden: (seedId, gardenPath) => {
        void this.linkSeedGarden(seedId, gardenPath);
      },
      onUnlinkGarden: (seedId, gardenPath) => {
        void this.unlinkSeedGarden(seedId, gardenPath);
      },
      onRunLinkedGarden: (seedId, input) => {
        void this.runSeedLinkedGarden(seedId, input);
      },
      onApplyStatusSuggestion: (seedId, status) => {
        void this.applySeedStatusSuggestion(seedId, status);
      },
      onSave: (seedId, patch) => {
        void this.saveSeed(seedId, patch);
      },
    });

    this.draftStreamer = new DraftStreamer(getOrCreateTabId());
    this.workspaceStream = new WorkspaceStream({
      onEvent: (event) => {
        this.handleWorkspaceEvent(event);
      },
      onError: () => {
        // EventSource retries automatically.
      },
    });

    this.viewNav = new ViewNav({
      onChange: (view) => {
        this.setView(view, true);
      },
    });

    const shell = document.createElement('div');
    shell.className = 'hive-shell';

    this.gardenLayout = this.buildGardenLayout();
    this.seedbedLayout = this.buildSeedbedLayout();
    this.seedbedLayout.classList.add('is-hidden');

    shell.append(this.viewNav.element, this.gardenLayout, this.seedbedLayout);
    this.root.append(shell);
  }

  async initialize(): Promise<void> {
    await Promise.all([this.refreshGardens(), this.refreshSeeds()]);

    const params = new URLSearchParams(window.location.search);
    const viewParam = params.get('view');
    const gardenParam = params.get('garden');
    const runParam = params.get('run_id');
    const seedParam = parseSeedIdParam(params.get('seed'));
    const seedScrollParam = Number.parseInt(params.get('seed_scroll') ?? '', 10);

    this.setView(viewParam === 'seedbed' ? 'seedbed' : 'gardens', false);

    if (gardenParam && this.gardens.some((garden) => garden.name === gardenParam)) {
      await this.loadGarden(gardenParam);
    } else if (this.gardens[0]) {
      await this.loadGarden(this.gardens[0].name);
    }

    if (runParam) {
      await this.attachRun(runParam, false);
    }

    if (Number.isFinite(seedScrollParam) && seedScrollParam > 0) {
      this.seedBoard.setScroll(seedScrollParam);
    }

    if (seedParam) {
      await this.selectSeed(seedParam, false);
    } else if (this.viewMode === 'seedbed' && this.seeds[0]) {
      await this.selectSeed(this.seeds[0].id, false);
    }

    this.workspaceStream.connect();
    this.syncUrl();
  }

  private buildGardenLayout(): HTMLElement {
    const layout = document.createElement('div');
    layout.className = 'hive-root garden-layout';

    const left = document.createElement('aside');
    left.className = 'left-column';
    left.append(this.sidebar.element);

    const center = document.createElement('main');
    center.className = 'center-column';
    center.append(this.draftComposer.element, this.editor.element, this.diagnostics.element);

    const right = document.createElement('section');
    right.className = 'right-column';
    right.append(this.preview.element, this.runPanel.element, this.questionTray.element);

    layout.append(left, center, right);
    return layout;
  }

  private buildSeedbedLayout(): HTMLElement {
    const layout = document.createElement('div');
    layout.className = 'hive-root seedbed-layout';

    const left = document.createElement('aside');
    left.className = 'left-column';
    left.append(this.seedComposer.element);

    const center = document.createElement('main');
    center.className = 'center-column';
    center.append(this.seedBoard.element);

    const right = document.createElement('section');
    right.className = 'right-column';
    right.append(this.seedDetail.element);

    layout.append(left, center, right);
    return layout;
  }

  private setView(view: HiveView, syncUrl: boolean): void {
    this.viewMode = view;
    this.viewNav.setView(view);
    this.gardenLayout.classList.toggle('is-hidden', view !== 'gardens');
    this.seedbedLayout.classList.toggle('is-hidden', view !== 'seedbed');

    if (syncUrl) {
      this.syncUrl();
    }
  }

  private async refreshGardens(): Promise<void> {
    try {
      this.sidebar.setStatus('Loading gardens...');
      this.gardens = await api.listGardens();
      this.sidebar.renderGardens(this.gardens, this.selectedGarden);
      this.sidebar.setStatus(`${this.gardens.length} garden${this.gardens.length === 1 ? '' : 's'}`);
    } catch (error) {
      this.sidebar.setStatus(`Failed to load gardens: ${toMessage(error)}`);
    }
  }

  private async refreshSeeds(): Promise<void> {
    try {
      this.seedBoard.setStatus('Loading seeds...');
      this.seeds = (await api.listSeeds()).sort((a, b) => a.id - b.id);
      this.seedBoard.setSeeds(this.seeds, this.selectedSeedId);

      if (this.selectedSeedId && !this.seeds.some((seed) => seed.id === this.selectedSeedId)) {
        this.selectedSeedId = null;
        this.seedDetail.setEmpty('Selected seed no longer exists.');
      }

      this.seedBoard.setStatus(`${this.seeds.length} seed${this.seeds.length === 1 ? '' : 's'}`);
    } catch (error) {
      this.seedBoard.setStatus(`Failed to load seeds: ${toMessage(error)}`);
    }
  }

  private async loadGarden(name: string): Promise<void> {
    try {
      this.sidebar.setStatus(`Loading ${name}...`);
      const garden = await api.getGarden(name);
      this.selectedGarden = name;
      this.savedSource = garden.dot_source;
      this.lastValidPreviewSvg = null;

      this.editor.setEnabled(true);
      this.editor.setFileName(name);
      this.editor.setValue(garden.dot_source);
      this.editor.setDirty(false);
      this.editor.setStatus('Garden loaded.');
      this.runPanel.setSelectedGarden(name);

      this.sidebar.renderGardens(this.gardens, name);
      this.sidebar.setStatus(`${this.gardens.length} garden${this.gardens.length === 1 ? '' : 's'}`);

      this.syncUrl();
      await this.requestPreview();
    } catch (error) {
      this.sidebar.setStatus(`Failed to load ${name}: ${toMessage(error)}`);
    }
  }

  private handleEditorChange(): void {
    const dirty = this.editor.getValue() !== this.savedSource;
    this.editor.setDirty(dirty);
    this.editor.setStatus(dirty ? 'Unsaved changes' : 'No unsaved changes');

    this.schedulePreview();
  }

  private schedulePreview(): void {
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
    }

    this.previewTimer = window.setTimeout(() => {
      void this.requestPreview();
    }, 300);
  }

  private async requestPreview(): Promise<void> {
    if (!this.selectedGarden) {
      return;
    }

    const requestSeq = ++this.previewRequestSeq;

    this.previewAbort?.abort();
    const abortController = new AbortController();
    this.previewAbort = abortController;

    try {
      const source = this.editor.getValue();
      const result = await api.previewGarden(source, `gardens/${this.selectedGarden}`, abortController.signal);
      if (requestSeq !== this.previewRequestSeq) {
        return;
      }

      this.diagnostics.setDiagnostics(result.diagnostics);
      this.preview.setMetadata(result.metadata.node_count, result.metadata.edge_count);

      if (this.runStatus === 'running' && this.runId) {
        return;
      }

      if (result.parse_ok && result.svg) {
        this.lastValidPreviewSvg = result.svg;
        this.preview.setSvg(result.svg, 'Live preview from unsaved editor buffer.');
        return;
      }

      if (this.lastValidPreviewSvg) {
        this.preview.setSvg(this.lastValidPreviewSvg, 'Current buffer invalid; showing last valid SVG.');
      } else {
        this.preview.setEmpty('Current buffer is invalid and no valid preview exists yet.');
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        return;
      }
      this.preview.setEmpty(`Preview request failed: ${toMessage(error)}`);
    }
  }

  private async saveCurrentGarden(): Promise<void> {
    if (!this.selectedGarden) {
      return;
    }

    try {
      const source = this.editor.getValue();
      const saved = await api.saveGarden(this.selectedGarden, source);
      this.savedSource = source;
      this.editor.setDirty(false);
      this.editor.setStatus('Saved.');
      this.diagnostics.setDiagnostics(saved.diagnostics);
      await this.refreshGardens();
    } catch (error) {
      this.editor.setStatus(`Save failed: ${toMessage(error)}`);
    }
  }

  private startDraft(prompt: string): void {
    this.draftComposer.setBusy(true);
    this.draftComposer.setStatus('Drafting DOT...');

    let streamBuffer = '';
    this.draftStreamer.start(
      { prompt },
      {
        onEvent: (event) => {
          if (event.type === 'draft_start') {
            streamBuffer = '';
            this.editor.setValue('');
            this.handleEditorChange();
            return;
          }

          if (event.type === 'content_delta') {
            streamBuffer += event.text;
            this.editor.setValue(streamBuffer);
            this.handleEditorChange();
            return;
          }

          if (event.type === 'draft_complete') {
            const dotSource = event.dot_source || streamBuffer;
            this.editor.setValue(dotSource);
            this.handleEditorChange();
            this.draftComposer.setStatus('Draft complete. Review and save when ready.');
          }

          if (event.type === 'draft_error') {
            this.draftComposer.setStatus(`Draft failed: ${event.error}`);
          }
        },
        onError: (error) => {
          this.draftComposer.setBusy(false);
          this.draftComposer.setStatus(`Draft failed: ${error.message}`);
        },
        onDone: () => {
          this.draftComposer.setBusy(false);
        },
      }
    );
  }

  private stopDraft(): void {
    this.draftStreamer.stop();
    this.draftComposer.setBusy(false);
    this.draftComposer.setStatus('Draft stream stopped.');
  }

  private async createSeed(input: SeedComposerSubmitInput): Promise<void> {
    this.seedComposer.setBusy(true);
    this.seedComposer.setStatus('Planting seed...');

    try {
      const created = await api.createSeed({
        title: input.title,
        body: input.body,
        priority: input.priority,
        tags: input.tags,
      });

      for (const file of input.files) {
        await api.uploadSeedAttachment(created.seed.id, file);
      }

      if (input.analyze_now) {
        await api.analyzeSeed(created.seed.id, {
          providers: ['claude', 'codex', 'gemini'],
          include_attachments: true,
        });
      }

      await this.refreshSeeds();
      await this.selectSeed(created.seed.id);
      this.seedComposer.clear();
      this.seedComposer.setStatus(`Seed #${created.seed.id} planted.`);
      this.setView('seedbed', true);
    } catch (error) {
      this.seedComposer.setStatus(`Failed to plant seed: ${toMessage(error)}`);
    } finally {
      this.seedComposer.setBusy(false);
    }
  }

  private async moveSeed(seedId: number, nextStatus: SeedStatus): Promise<void> {
    const current = this.seeds.find((seed) => seed.id === seedId);
    if (!current || current.status === nextStatus) {
      return;
    }

    const previous = this.seeds;
    this.seeds = this.seeds.map((seed) =>
      seed.id === seedId
        ? {
            ...seed,
            status: nextStatus,
          }
        : seed
    );
    this.seedBoard.setSeeds(this.seeds, this.selectedSeedId);

    try {
      await api.patchSeed(seedId, { status: nextStatus });
      await this.refreshSeeds();
      if (this.selectedSeedId === seedId) {
        await this.selectSeed(seedId, false);
      }
    } catch (error) {
      this.seeds = previous;
      this.seedBoard.setSeeds(this.seeds, this.selectedSeedId);
      this.seedDetail.setStatus(`Move failed: ${toMessage(error)}`);
    }
  }

  private async selectSeed(seedId: number, syncUrl = true): Promise<void> {
    this.selectedSeedId = seedId;
    this.seedBoard.setSeeds(this.seeds, this.selectedSeedId);
    if (syncUrl) {
      this.syncUrl();
    }

    this.seedDetail.setStatus(`Loading seed #${seedId}...`);
    try {
      const [detail, synthesis] = await Promise.all([
        api.getSeed(seedId),
        api.getSeedSynthesis(seedId).catch(() => null),
      ]);
      this.seedDetail.setSeed(detail, synthesis);
    } catch (error) {
      this.seedDetail.setEmpty(`Failed to load seed: ${toMessage(error)}`);
    }
  }

  private async triggerSeedAnalysis(seedId: number, force: boolean): Promise<void> {
    this.seedDetail.setStatus(force ? 'Starting analysis rerun...' : 'Starting analysis...');
    try {
      const started = await api.analyzeSeed(seedId, {
        providers: ['claude', 'codex', 'gemini'],
        force,
        include_attachments: true,
      });

      if (started.accepted_providers.length > 0) {
        this.seeds = this.seeds.map((seed) => {
          if (seed.id !== seedId) {
            return seed;
          }
          const nextStatus = { ...seed.analysis_status };
          for (const provider of started.accepted_providers) {
            nextStatus[provider] = 'running';
          }
          return {
            ...seed,
            analysis_status: nextStatus,
          };
        });
        this.seedBoard.setSeeds(this.seeds, this.selectedSeedId);
      }

      this.seedDetail.setStatus(started.already_running ? 'Analysis already running.' : 'Analysis started.');
      if (this.selectedSeedId === seedId) {
        await this.selectSeed(seedId, false);
      }
    } catch (error) {
      this.seedDetail.setStatus(`Failed to start analysis: ${toMessage(error)}`);
    }
  }

  private async saveSeed(
    seedId: number,
    patch: {
      title?: string;
      body?: string;
      priority?: SeedPriority;
      tags?: string[];
    }
  ): Promise<void> {
    try {
      this.seedDetail.setStatus(`Saving seed #${seedId}...`);
      await api.patchSeed(seedId, {
        title: patch.title,
        body: patch.body,
        priority: patch.priority,
        tags: patch.tags,
      });
      await this.refreshSeeds();
      await this.selectSeed(seedId, false);
      this.seedDetail.setStatus('Seed saved.');
    } catch (error) {
      this.seedDetail.setStatus(`Failed to save seed: ${toMessage(error)}`);
    }
  }

  private async linkSeedGarden(seedId: number, gardenPath: string): Promise<void> {
    try {
      this.seedDetail.setStatus(`Linking ${gardenPath}...`);
      await api.patchSeed(seedId, {
        linked_gardens_add: [gardenPath],
      });
      await this.refreshSeeds();
      await this.selectSeed(seedId, false);
      this.seedDetail.setStatus(`Linked ${gardenPath}.`);
    } catch (error) {
      this.seedDetail.setStatus(`Failed to link garden: ${toMessage(error)}`);
    }
  }

  private async unlinkSeedGarden(seedId: number, gardenPath: string): Promise<void> {
    try {
      this.seedDetail.setStatus(`Unlinking ${gardenPath}...`);
      await api.patchSeed(seedId, {
        linked_gardens_remove: [gardenPath],
      });
      await this.refreshSeeds();
      await this.selectSeed(seedId, false);
      this.seedDetail.setStatus(`Unlinked ${gardenPath}.`);
    } catch (error) {
      this.seedDetail.setStatus(`Failed to unlink garden: ${toMessage(error)}`);
    }
  }

  private async runSeedLinkedGarden(
    seedId: number,
    input: { garden_path?: string; run_id?: string }
  ): Promise<void> {
    try {
      this.seedDetail.setStatus(input.run_id ? `Resuming ${input.run_id}...` : 'Starting linked run...');
      const started = await api.startSeedRun(seedId, {
        garden_path: input.garden_path,
        run_id: input.run_id,
      });
      await this.refreshSeeds();
      await this.selectSeed(seedId, false);
      this.seedDetail.setStatus(
        started.resumed
          ? `Resumed run ${started.run_id}.`
          : `Started run ${started.run_id}.`
      );
    } catch (error) {
      this.seedDetail.setStatus(`Failed to launch linked run: ${toMessage(error)}`);
    }
  }

  private async applySeedStatusSuggestion(seedId: number, status: 'honey'): Promise<void> {
    try {
      this.seedDetail.setStatus(`Updating seed status to ${status}...`);
      await api.patchSeed(seedId, { status });
      await this.refreshSeeds();
      await this.selectSeed(seedId, false);
      this.seedDetail.setStatus(`Seed moved to ${status}.`);
    } catch (error) {
      this.seedDetail.setStatus(`Failed to update status: ${toMessage(error)}`);
    }
  }

  private handleWorkspaceEvent(event: WorkspaceEvent): void {
    if (event.type === 'garden_changed') {
      void this.refreshGardens();
      return;
    }

    if (event.type.startsWith('seed_')) {
      this.scheduleSeedRefresh();
    }
  }

  private scheduleSeedRefresh(): void {
    if (this.seedRefreshTimer !== null) {
      window.clearTimeout(this.seedRefreshTimer);
    }

    this.seedRefreshTimer = window.setTimeout(() => {
      void this.refreshSeeds();
      if (this.selectedSeedId) {
        void this.selectSeed(this.selectedSeedId, false);
      }
    }, 150);
  }

  private async startRun(): Promise<void> {
    if (!this.selectedGarden) {
      this.runPanel.setRunState(this.runId, 'idle');
      return;
    }

    try {
      const started = await api.startPipeline({ dot_path: `gardens/${this.selectedGarden}` });
      this.runPanel.clearTimeline();
      await this.attachRun(started.run_id, true);
    } catch (error) {
      this.runPanel.appendEnvelope(createSyntheticEnvelope('run_error', { message: toMessage(error) }));
    }
  }

  private async cancelRun(): Promise<void> {
    if (!this.runId) {
      return;
    }

    try {
      const status = await api.cancelPipeline(this.runId);
      this.runStatus = status.status;
      this.runPanel.setRunState(this.runId, status.status);
    } catch (error) {
      this.runPanel.appendEnvelope(createSyntheticEnvelope('run_error', { message: toMessage(error) }));
    }
  }

  private async resumeRun(): Promise<void> {
    if (!this.runId) {
      return;
    }

    try {
      const resumed = await api.resumePipeline(this.runId);
      this.runPanel.setRunState(resumed.run_id, 'running');
      this.runStatus = 'running';
      this.openRunStream(this.runId, this.runStream?.getLastEventId());
      await this.refreshQuestions();
    } catch (error) {
      this.runPanel.appendEnvelope(createSyntheticEnvelope('run_error', { message: toMessage(error) }));
    }
  }

  private async answerQuestion(questionId: string, selectedLabel: string): Promise<void> {
    if (!this.runId) {
      return;
    }

    try {
      this.questionTray.setStatus(`Submitting answer: ${selectedLabel}...`);
      await api.answerQuestion(this.runId, questionId, selectedLabel);
      await this.refreshQuestions();
      this.questionTray.setStatus('Answer submitted. Waiting for next event...');
    } catch (error) {
      this.questionTray.setStatus(`Failed to submit answer: ${toMessage(error)}`);
    }
  }

  private async attachRun(runId: string, updateUrl: boolean): Promise<void> {
    this.runId = runId;
    this.runStatus = 'running';
    this.runPanel.setRunState(runId, 'running');

    if (updateUrl) {
      this.syncUrl();
    }

    this.openRunStream(runId);

    try {
      const status = await api.getPipelineStatus(runId);
      this.runStatus = status.status;
      this.runPanel.setRunState(runId, status.status);
      this.runPanel.setCurrentNode(status.current_node);

      await Promise.all([this.refreshRunGraph(), this.refreshQuestions(), this.refreshFanIn()]);
    } catch (error) {
      this.runPanel.appendEnvelope(createSyntheticEnvelope('run_error', { message: toMessage(error) }));
    }
  }

  private openRunStream(runId: string, fromEventId?: number): void {
    this.runStream?.close();

    const stream = new RunStream(runId, {
      onEnvelope: (envelope) => {
        this.handleRunEnvelope(envelope);
      },
      onError: () => {
        // Native EventSource retries automatically; keep UI status stable.
      },
    });

    stream.connect(fromEventId);
    this.runStream = stream;
  }

  private handleRunEnvelope(envelope: EventEnvelope): void {
    this.runPanel.appendEnvelope(envelope);

    const event = envelope.event;
    if (event.type === 'run_started') {
      this.runStatus = 'running';
      this.runPanel.setRunState(this.runId, 'running');
    }
    if (event.type === 'run_completed') {
      this.runStatus = 'completed';
    }
    if (event.type === 'pipeline_failed' || event.type === 'run_error') {
      this.runStatus = 'failed';
    }
    if (event.type === 'run_interrupted') {
      this.runStatus = 'interrupted';
    }

    if (event.type === 'node_completed') {
      const outcome = event.outcome as Record<string, unknown> | undefined;
      const updates = outcome?.['context_updates'] as Record<string, string> | undefined;
      if (updates) {
        this.runPanel.setFanIn(updates['parallel.fan_in.best_id'], updates['parallel.fan_in.rationale']);
      }
    }

    if (
      event.type === 'node_started'
      || event.type === 'node_completed'
      || event.type === 'stage_failed'
      || event.type === 'run_completed'
      || event.type === 'pipeline_failed'
      || event.type === 'run_interrupted'
    ) {
      void this.refreshRunGraph();
    }

    if (event.type === 'human_question' || event.type === 'human_answer' || event.type === 'run_started') {
      void this.refreshQuestions();
    }
  }

  private async refreshRunGraph(): Promise<void> {
    if (!this.runId) {
      return;
    }

    try {
      const svg = await api.getPipelineGraph(this.runId);
      this.preview.setSvg(svg, `Run graph for ${this.runId}`);
    } catch {
      // Best-effort while run is active.
    }
  }

  private async refreshQuestions(): Promise<void> {
    if (!this.runId) {
      this.questionTray.setQuestions([]);
      return;
    }

    try {
      const payload = await api.getQuestions(this.runId);
      this.questionTray.setQuestions(payload.questions);
    } catch (error) {
      this.questionTray.setStatus(`Failed to load questions: ${toMessage(error)}`);
    }
  }

  private async refreshFanIn(): Promise<void> {
    if (!this.runId) {
      this.runPanel.setFanIn(undefined, undefined);
      return;
    }

    try {
      const payload = await api.getPipelineContext(this.runId);
      const context = payload.context;
      this.runPanel.setFanIn(context['parallel.fan_in.best_id'], context['parallel.fan_in.rationale']);
    } catch {
      // Ignore context lookup errors during early run startup.
    }
  }

  private syncUrl(): void {
    const params = new URLSearchParams(window.location.search);
    params.set('view', this.viewMode);

    if (this.selectedGarden) {
      params.set('garden', this.selectedGarden);
    } else {
      params.delete('garden');
    }

    if (this.runId) {
      params.set('run_id', this.runId);
    } else {
      params.delete('run_id');
    }

    if (this.selectedSeedId) {
      params.set('seed', String(this.selectedSeedId));
    } else {
      params.delete('seed');
    }

    if (this.viewMode === 'seedbed') {
      const scroll = Math.round(this.seedBoard.getScroll());
      if (scroll > 0) {
        params.set('seed_scroll', String(scroll));
      } else {
        params.delete('seed_scroll');
      }
    } else {
      params.delete('seed_scroll');
    }

    const query = params.toString();
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}`;
    window.history.replaceState({}, '', nextUrl);
  }
}

function createSyntheticEnvelope(type: string, extra: Record<string, unknown>): EventEnvelope {
  return {
    seq: Date.now(),
    timestamp: new Date().toISOString(),
    event: {
      type,
      ...extra,
    },
  };
}

function getOrCreateTabId(): string {
  const key = 'nectar_hive_tab_id';
  const existing = window.sessionStorage.getItem(key);
  if (existing) {
    return existing;
  }

  const generated = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.sessionStorage.setItem(key, generated);
  return generated;
}

function parseSeedIdParam(raw: string | null): number | null {
  if (!raw) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function toMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message}${error.code ? ` (${error.code})` : ''}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
