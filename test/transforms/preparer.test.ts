import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PipelinePreparer } from '../../src/garden/preparer.js';
import type { Transform } from '../../src/transforms/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-preparer-'));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('PipelinePreparer', () => {
  it('runs built-ins before custom transforms, and custom transforms in registration order', async () => {
    const workspace = await createWorkspace();
    const childPath = path.join(workspace, 'child.dot');
    const parentPath = path.join(workspace, 'parent.dot');

    await writeFile(
      childPath,
      `digraph Child {
        graph [goal="child goal"]
        c_start [shape=Mdiamond]
        c_work [shape=box, prompt="Task: $goal"]
        c_exit [shape=Msquare]
        c_start -> c_work -> c_exit
      }`,
      'utf8',
    );

    await writeFile(
      parentPath,
      `digraph Parent {
        graph [goal="parent goal", model_stylesheet="box { llm_model: parent-model }"]
        start [shape=Mdiamond]
        module [shape=component, "compose.dotfile"="child.dot"]
        done [shape=Msquare]
        start -> module -> done
      }`,
      'utf8',
    );

    const calls: string[] = [];
    const first: Transform = {
      name: 'custom-first',
      apply(graph) {
        calls.push('custom-first');
        const imported = graph.nodeMap.get('module__c_work');
        if (!imported) {
          throw new Error('composition did not run before custom transform');
        }
        if (graph.nodeMap.has('module')) {
          throw new Error('compose placeholder still present after built-ins');
        }
        if (imported.prompt !== 'Task: child goal') {
          throw new Error('goal expansion did not run before composition');
        }
        if (imported.llmModel !== undefined) {
          throw new Error('parent stylesheet should run before composition');
        }
        graph.graphAttributes.custom_first = 'yes';
        return { graph, diagnostics: [] };
      },
    };

    const second: Transform = {
      name: 'custom-second',
      apply(graph) {
        calls.push('custom-second');
        if (graph.graphAttributes.custom_first !== 'yes') {
          throw new Error('custom transforms are not running in registration order');
        }
        graph.graphAttributes.custom_second = 'yes';
        return { graph, diagnostics: [] };
      },
    };

    const preparer = new PipelinePreparer({ workspaceRoot: workspace });
    preparer.registerTransform(first);
    preparer.registerTransform(second);

    const result = await preparer.prepareFromPath(parentPath);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toHaveLength(0);
    expect(calls).toEqual(['custom-first', 'custom-second']);
    expect(result.graph.graphAttributes.custom_first).toBe('yes');
    expect(result.graph.graphAttributes.custom_second).toBe('yes');
  });

  it('keeps custom transform registration isolated per preparer instance', async () => {
    const dotSource = `digraph G {
      start [shape=Mdiamond]
      work [shape=parallelogram, script="echo hi"]
      done [shape=Msquare]
      start -> work -> done
    }`;

    const one = new PipelinePreparer({ workspaceRoot: process.cwd() });
    const two = new PipelinePreparer({ workspaceRoot: process.cwd() });

    one.registerTransform({
      name: 'stamp-one',
      apply(graph) {
        graph.graphAttributes.stamp = 'one';
        return { graph, diagnostics: [] };
      },
    });

    two.registerTransform({
      name: 'stamp-two',
      apply(graph) {
        graph.graphAttributes.stamp = 'two';
        return { graph, diagnostics: [] };
      },
    });

    const oneResult = await one.prepareFromSource(dotSource, '<one>');
    const twoResult = await two.prepareFromSource(dotSource, '<two>');

    expect(oneResult.graph.graphAttributes.stamp).toBe('one');
    expect(twoResult.graph.graphAttributes.stamp).toBe('two');
    expect(one.listTransforms().map((transform) => transform.name)).toEqual(['stamp-one']);
    expect(two.listTransforms().map((transform) => transform.name)).toEqual(['stamp-two']);
  });
});
