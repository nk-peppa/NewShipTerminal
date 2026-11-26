import test from 'node:test';
import assert from 'node:assert/strict';
import { SlamMapView } from '../src/renderer/slamMap.js';
import type { PoseView } from '../src/shared/api.js';

test('invalid poses remain visible as status but do not extend the trajectory or move the viewport', () => {
  const view = new SlamMapView();
  const pose = { x: 1, y: 2, yaw: 0, status: 'TRACKING', poseValid: true } as PoseView;
  view.pushPose(pose);
  const internal = view as unknown as { track: number[][]; center: { x: number; y: number }; pose: PoseView };
  const track = structuredClone(internal.track);
  const center = { ...internal.center };
  const labels: string[] = [];
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get: (_, key) => key === 'fillText' ? (text: string) => labels.push(text) : () => {},
  });
  for (const status of ['INITIALIZING: 1/3', 'RECOVERING: confirming 1/3', 'LOST: gap', 'DEGENERATE: weak geometry']) {
    view.pushPose({ ...pose, x: 50, y: 60, status, poseValid: false });
    assert.deepEqual(internal.track, track);
    assert.deepEqual(internal.center, center);
    assert.equal(view.lastStatus, status);
    assert.equal(internal.pose.poseValid, false);
    labels.length = 0;
    view.render(ctx, 800, 600, 1);
    assert.ok(labels.some(text => text.startsWith('Pose unknown')));
  }
  view.pushPose({ ...pose, x: 2 });
  assert.equal(internal.track.length, 2);
  labels.length = 0;
  view.render(ctx, 800, 600, 1);
  assert.ok(!labels.some(text => text.startsWith('Pose unknown')));
});
