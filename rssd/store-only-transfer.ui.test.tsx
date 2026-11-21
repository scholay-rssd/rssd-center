import React from 'react';
import {render, screen, fireEvent, waitFor, cleanup} from '@testing-library/react';
import {StoreOnlyTransferPanel} from '../apps/frontend/src/components/rssd/store-only-transfer-panel';
import {
  loadDemandsByIds,
  summarizeTransferResults,
  classifyTransferOutcome,
  previewIsCurrent,
  parseDemandIds,
  mergeReceipts,
  freezePreviewRow,
  stableTransferRequestId,
} from '../apps/frontend/src/components/rssd/store-only-transfer-logic';

jest.mock('@gitroom/frontend/components/layout/user.context', () => ({useUser: () => ({orgId: 'fixture-org'})}));
jest.mock('../apps/frontend/src/components/rssd/api', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

const LOCAL_WORKER_ID = '2c7fb3bf-fa03-403e-a0f0-316d227fbed8';
const workers = [
  {id: LOCAL_WORKER_ID, name: 'Mac Cursor', workspaceIds: ['metho', 'enter'], revokedAt: null},
  // Same display name as the local worker — options must still show the full unique id.
  {id: 'other-device-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'Mac Cursor', workspaceIds: ['pets'], revokedAt: null},
];
const registry = [{id: 'metho', name: 'Metho'}, {id: 'enter', name: 'Enter'}, {id: 'pets', name: 'Pets'}];

function demand(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: 'title-' + id,
    state: 'queued',
    workerId: null,
    generation: 0,
    workspaceId: 'metho',
    sectionId: 'methods',
    payload: {
      storeOnly: true,
      storeOnlyWorkerId: 'creator',
      source: {workId: 'work-' + id, locale: 'zh-CN', revision: 1},
      sourceHash: 'a'.repeat(64),
    },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test('loadDemandsByIds paginates beyond 200 and only returns pasted ids', async () => {
  const pages: any[] = [];
  const all = Array.from({length: 250}, (_, i) => demand('tr-' + i));
  pages.push({items: all.slice(0, 200), total: 250, limit: 200, offset: 0});
  pages.push({items: all.slice(200), total: 250, limit: 200, offset: 200});
  let calls = 0;
  const api = jest.fn(async () => pages[calls++]);
  const found = await loadDemandsByIds(api as any, ['tr-0', 'tr-199', 'tr-249', 'tr-missing']);
  expect(api).toHaveBeenCalledTimes(2);
  expect([...found.keys()].sort()).toEqual(['tr-0', 'tr-199', 'tr-249']);
  expect(found.has('tr-missing')).toBe(false);
});

test('panel shows full unique device ids in options and frozen preview, invalidates on edit, never marks skips as allTransferred', async () => {
  const api = jest.fn(async (path: string, method = 'GET', body?: any) => {
    if (path.startsWith('/demands?')) {
      return {items: [demand('tr-1'), demand('tr-2', {state: 'claimed', workerId: 'creator'})], total: 2, limit: 200, offset: 0};
    }
    if (method === 'POST' && path.includes('/transfer-store-only')) {
      return {
        status: 'transferred',
        liveOwnership: {storeOnlyWorkerId: LOCAL_WORKER_ID, generation: 1},
        demand: {payload: {storeOnlyWorkerId: LOCAL_WORKER_ID}},
      };
    }
    throw new Error('unexpected ' + path);
  });

  render(<StoreOnlyTransferPanel api={api as any} registry={registry} workers={workers} />);
  const options = screen.getAllByRole('option').map((node) => node.textContent || '');
  expect(options.some((text) => text.includes(LOCAL_WORKER_ID))).toBe(true);
  expect(options.filter((text) => text.includes('Mac Cursor')).length).toBe(2);
  expect(options.every((text) => !text.includes('Mac Cursor') || /[0-9a-f-]{36}/i.test(text))).toBe(true);

  fireEvent.change(screen.getByRole('combobox'), {target: {value: LOCAL_WORKER_ID}});
  fireEvent.change(screen.getByPlaceholderText('tr-…'), {target: {value: 'tr-1\ntr-2'}});
  fireEvent.click(screen.getByRole('button', {name: '预览并冻结'}));
  await screen.findByText(/冻结目标/);
  expect(screen.getByText(LOCAL_WORKER_ID)).toBeTruthy();
  expect((screen.getByRole('button', {name: /对冻结预览中的 1 条执行移交/}) as HTMLButtonElement).disabled).toBe(false);

  fireEvent.change(screen.getByRole('combobox'), {target: {value: workers[1].id}});
  await waitFor(() => expect((screen.getByRole('button', {name: /对冻结预览中的 0 条执行移交/}) as HTMLButtonElement).disabled).toBe(true));
  expect((await screen.findAllByRole('status')).some((node) => /旧预览已失效|清单或目标/.test(node.textContent || ''))).toBe(true);

  // Restore selection and preview again, then run.
  fireEvent.change(screen.getByRole('combobox'), {target: {value: LOCAL_WORKER_ID}});
  fireEvent.click(screen.getByRole('button', {name: '预览并冻结'}));
  await screen.findByText(/冻结目标/);
  expect(screen.getByText(LOCAL_WORKER_ID)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: /对冻结预览中的 1 条执行移交/}));
  await waitFor(() => expect(screen.getByText(/全部可移交项已确认归属目标设备/)).toBeTruthy());
  expect(screen.getAllByText(/跳过 1/).length).toBeGreaterThan(0);
  expect(screen.getByText(/可移交项已全部确认/)).toBeTruthy();
  expect(screen.queryByText(/全部成功/)).toBeNull();
});

test('existing replay without live target ownership is not allTransferred', () => {
  const classified = classifyTransferOutcome({
    receipt: {status: 'existing', liveOwnership: {storeOnlyWorkerId: 'someone-else'}},
    toWorkerId: LOCAL_WORKER_ID,
  });
  const summary = summarizeTransferResults([{demandId: 'tr-1', ...classified}]);
  expect(summary.allTransferred).toBe(false);
  expect(summary.existingStale).toBe(1);
  expect(previewIsCurrent({rawIds: 'a', toWorkerId: LOCAL_WORKER_ID, preview: []}, 'a', LOCAL_WORKER_ID)).toBe(true);
});

test('logic helpers: parse, skip vs transfer, confirmed replay, merge without blocking stale', async () => {
  expect(parseDemandIds('tr-a\ntr-b, tr-a')).toEqual(['tr-a', 'tr-b']);
  expect(() => parseDemandIds('bad id!')).toThrow(/无效的任务编号/);
  const queued = demand('tr-9');
  expect(freezePreviewRow(queued, LOCAL_WORKER_ID).action).toBe('transfer');
  expect(freezePreviewRow({...queued, state: 'claimed', workerId: 'creator'}, LOCAL_WORKER_ID).reason).toBe('claimed_or_blocked');
  const confirmed = classifyTransferOutcome({
    receipt: {status: 'existing', liveOwnership: {storeOnlyWorkerId: LOCAL_WORKER_ID}},
    toWorkerId: LOCAL_WORKER_ID,
  });
  expect(confirmed.confirmedTransfer).toBe(true);
  const withSkips = summarizeTransferResults([
    {demandId: 'tr-1', status: 'transferred', confirmedTransfer: true},
    {demandId: 'tr-2', status: 'skipped'},
  ]);
  expect(withSkips.allTransferred).toBe(true);
  expect(withSkips.allSucceeded).toBe(false);
  const onlySkips = summarizeTransferResults([{demandId: 'tr-1', status: 'skipped'}]);
  expect(onlySkips.allTransferred).toBe(false);

  // Review #12: stale-owner replay must supersede prior confirmed success.
  const staleMerge = mergeReceipts(
    [{
      demandId: 'a',
      requestId: 'old',
      status: 'existing_confirmed',
      confirmedTransfer: true,
      liveOwnership: {storeOnlyWorkerId: 'A'},
    }],
    [{
      demandId: 'a',
      requestId: 'new',
      status: 'existing_stale',
      confirmedTransfer: false,
      liveOwnership: {storeOnlyWorkerId: 'B'},
    }],
  );
  expect(staleMerge.current[0].status).toBe('existing_stale');
  expect(staleMerge.current[0].confirmedTransfer).toBe(false);
  expect(staleMerge.history[0].status).toBe('existing_confirmed');
  expect(summarizeTransferResults(staleMerge.current).allSucceeded).toBe(false);
  expect(summarizeTransferResults(staleMerge.current).allTransferred).toBe(false);

  // (a) transferred to A then new target B / different request
  const retarget = mergeReceipts(
    [{demandId: 'a', requestId: 'req-A', status: 'transferred', confirmedTransfer: true, liveOwnership: {storeOnlyWorkerId: 'A'}}],
    [{demandId: 'a', requestId: 'req-B', status: 'existing_stale', confirmedTransfer: false, liveOwnership: {storeOnlyWorkerId: 'A'}}],
  );
  expect(retarget.current[0].requestId).toBe('req-B');
  expect(retarget.history).toHaveLength(1);

  // (c) old results for IDs absent from the new manifest not counted in new summary
  const absent = mergeReceipts(
    [
      {demandId: 'keep', requestId: 'r1', status: 'transferred', confirmedTransfer: true},
      {demandId: 'gone', requestId: 'r2', status: 'transferred', confirmedTransfer: true},
    ],
    [{demandId: 'keep', requestId: 'r1', status: 'existing_confirmed', confirmedTransfer: true}],
  );
  expect(absent.current.map((row) => row.demandId)).toEqual(['keep']);
  expect(absent.history.some((row) => row.demandId === 'gone')).toBe(true);
  expect(summarizeTransferResults(absent.current).confirmedTransfers).toBe(1);

  // Network after same-request success → historical success + currently unverified
  const network = mergeReceipts(
    [{demandId: 'a', requestId: 'same', status: 'transferred', confirmedTransfer: true}],
    [{demandId: 'a', requestId: 'same', status: 'unresolved', confirmedTransfer: false, reason: 'network_or_unknown'}],
  );
  expect(network.current[0].status).toBe('unresolved');
  expect(network.current[0].confirmedTransfer).toBe(false);
  expect(network.history[0].confirmedTransfer).toBe(true);

  const a = await stableTransferRequestId({demandId: 'tr-1', expectedGeneration: 0, expectedStoreOnlyWorkerId: 'c', toWorkerId: LOCAL_WORKER_ID});
  const b = await stableTransferRequestId({demandId: 'tr-1', expectedGeneration: 0, expectedStoreOnlyWorkerId: 'c', toWorkerId: LOCAL_WORKER_ID});
  expect(a).toBe(b);
});
