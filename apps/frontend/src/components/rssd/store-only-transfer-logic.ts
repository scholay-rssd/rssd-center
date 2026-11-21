/** Pure Owner UI helpers for store-only ownership transfer. No manuscript bodies. */

export type TransferResultRow = {
  demandId: string;
  status: string;
  confirmedTransfer?: boolean;
  reason?: string;
  message?: string;
  liveOwnership?: {storeOnlyWorkerId?: string; generation?: number; state?: string} | null;
  requestId?: string;
};

export function parseDemandIds(text: string) {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of String(text || '').split(/[\s,;]+/)) {
    const id = raw.trim();
    if (!id) continue;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id)) {
      throw new Error('无效的任务编号：' + id.slice(0, 80));
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function canonicalTransferIdentity(frozen: Record<string, unknown>) {
  const keys = ['demandId', 'expectedGeneration', 'expectedStoreOnlyWorkerId', 'toWorkerId'] as const;
  const object = Object.fromEntries(keys.map((key) => [key, frozen[key]]));
  return JSON.stringify(object);
}

export async function stableTransferRequestId(
  frozen: Record<string, unknown>,
  digest: (text: string) => Promise<string> = sha256Hex,
) {
  const hex = await digest(canonicalTransferIdentity(frozen));
  return 'xfer-' + hex.slice(0, 48);
}

export function freezePreviewRow(demand: any, toWorkerId: string) {
  if (!demand?.id) throw new Error('缺少任务');
  if (demand.payload?.storeOnly !== true) {
    return {demandId: demand.id, action: 'skip' as const, reason: 'not_store_only', title: demand.title || ''};
  }
  if (demand.state !== 'queued' || demand.workerId) {
    return {
      demandId: demand.id,
      action: 'skip' as const,
      reason: demand.state === 'claimed' || demand.state === 'blocked' ? 'claimed_or_blocked' : 'not_queued',
      state: demand.state,
      title: demand.title || '',
    };
  }
  const expectedStoreOnlyWorkerId = demand.payload.storeOnlyWorkerId;
  if (!expectedStoreOnlyWorkerId) {
    return {demandId: demand.id, action: 'skip' as const, reason: 'missing_creator', title: demand.title || ''};
  }
  if (expectedStoreOnlyWorkerId === toWorkerId) {
    return {demandId: demand.id, action: 'skip' as const, reason: 'already_target', title: demand.title || ''};
  }
  return {
    demandId: demand.id,
    action: 'transfer' as const,
    title: demand.title || '',
    workspaceId: demand.workspaceId,
    sectionId: demand.sectionId,
    state: demand.state,
    generation: demand.generation,
    expectedGeneration: demand.generation,
    expectedStoreOnlyWorkerId,
    toWorkerId,
    source: demand.payload.source || null,
    sourceHash: demand.payload.sourceHash || null,
  };
}

export function liveOwnershipMatchesTarget(liveOwnership: any, toWorkerId: string | null) {
  return Boolean(toWorkerId) && liveOwnership?.storeOnlyWorkerId === toWorkerId;
}

export function classifyTransferOutcome({
  receipt = null,
  error = null,
  toWorkerId = null,
  networkFailed = false,
}: {
  receipt?: any;
  error?: any;
  toWorkerId?: string | null;
  networkFailed?: boolean;
} = {}) {
  if (networkFailed || (!receipt && !error)) {
    return {status: 'unresolved', reason: 'network_or_unknown', confirmedTransfer: false as const};
  }
  if (error) {
    const code = error.code || 'error';
    if (['claim_conflict', 'revision_conflict', 'ownership_conflict', 'request_conflict', 'not_queued', 'forbidden'].includes(code)) {
      return {status: 'conflict', reason: code, confirmedTransfer: false as const, message: error.message as string | undefined};
    }
    return {status: 'error', reason: code, confirmedTransfer: false as const, message: error.message as string | undefined};
  }
  if (receipt.status === 'transferred') {
    if (liveOwnershipMatchesTarget(receipt.liveOwnership, toWorkerId)) {
      return {status: 'transferred', confirmedTransfer: true as const, liveOwnership: receipt.liveOwnership};
    }
    return {
      status: 'unresolved',
      reason: 'live_ownership_mismatch',
      confirmedTransfer: false as const,
      liveOwnership: receipt.liveOwnership,
    };
  }
  if (receipt.status === 'existing') {
    if (liveOwnershipMatchesTarget(receipt.liveOwnership, toWorkerId)) {
      return {status: 'existing_confirmed', confirmedTransfer: true as const, liveOwnership: receipt.liveOwnership, replay: true as const};
    }
    return {
      status: 'existing_stale',
      reason: 'historical_replay_not_current_owner',
      confirmedTransfer: false as const,
      liveOwnership: receipt.liveOwnership,
      replay: true as const,
    };
  }
  return {status: 'unresolved', reason: 'unexpected_receipt', confirmedTransfer: false as const};
}

export function summarizeTransferResults(results: TransferResultRow[]) {
  const summary = {
    transferred: 0,
    existingConfirmed: 0,
    existingStale: 0,
    conflict: 0,
    skipped: 0,
    error: 0,
    unresolved: 0,
    total: results.length,
    transferableAttempted: 0,
    confirmedTransfers: 0,
    completedWithoutErrors: false,
    allTransferred: false,
    anyFailure: false,
    allSucceeded: false,
  };
  for (const row of results) {
    if (row.status === 'transferred') {
      summary.transferred += 1;
      summary.transferableAttempted += 1;
      if (row.confirmedTransfer) summary.confirmedTransfers += 1;
    } else if (row.status === 'existing_confirmed') {
      summary.existingConfirmed += 1;
      summary.transferableAttempted += 1;
      if (row.confirmedTransfer) summary.confirmedTransfers += 1;
    } else if (row.status === 'existing_stale') {
      summary.existingStale += 1;
      summary.transferableAttempted += 1;
    } else if (row.status === 'existing') {
      summary.transferableAttempted += 1;
      if (row.confirmedTransfer) {
        summary.existingConfirmed += 1;
        summary.confirmedTransfers += 1;
      } else {
        summary.existingStale += 1;
      }
    } else if (row.status === 'skipped') {
      summary.skipped += 1;
    } else if (row.status === 'conflict') {
      summary.conflict += 1;
      summary.transferableAttempted += 1;
    } else if (row.status === 'unresolved') {
      summary.unresolved += 1;
      summary.transferableAttempted += 1;
    } else {
      summary.error += 1;
      summary.transferableAttempted += 1;
    }
  }
  summary.completedWithoutErrors = summary.error === 0 && summary.conflict === 0 && summary.unresolved === 0 && summary.existingStale === 0;
  summary.allTransferred =
    summary.transferableAttempted > 0
    && summary.confirmedTransfers === summary.transferableAttempted
    && summary.conflict === 0
    && summary.error === 0
    && summary.unresolved === 0
    && summary.existingStale === 0;
  summary.anyFailure = summary.error > 0 || summary.conflict > 0 || summary.unresolved > 0 || summary.existingStale > 0;
  summary.allSucceeded = summary.allTransferred && summary.skipped === 0;
  return summary;
}

export function previewIsCurrent(frozen: any, rawIds: string, toWorkerId: string) {
  if (!frozen || typeof frozen !== 'object') return false;
  return frozen.rawIds === rawIds && frozen.toWorkerId === toWorkerId && Array.isArray(frozen.preview);
}

/**
 * Build the *current batch* view from the latest frozen-run receipts.
 * Prior confirmed rows never block a fresher existing_stale / ownership mismatch /
 * different requestId / different target. IDs absent from `next` stay in history only
 * and must not affect the new summary. Network failure after a same-request success is
 * recorded as historical success plus currently-unverified (no live ownership claim).
 */
export function mergeReceipts(
  previous: TransferResultRow[] | null | undefined,
  next: TransferResultRow[] | null | undefined,
): {current: TransferResultRow[]; history: TransferResultRow[]} {
  const prevRows = (previous || []).filter((row) => row?.demandId);
  const nextRows = (next || []).filter((row) => row?.demandId);
  const nextByDemand = new Map(nextRows.map((row) => [row.demandId, row]));
  const history: TransferResultRow[] = [];
  const current: TransferResultRow[] = [];

  for (const row of nextRows) {
    const prior = prevRows.find((candidate) => candidate.demandId === row.demandId);
    if (!prior) {
      current.push(row);
      continue;
    }
    const sameRequest = Boolean(prior.requestId) && prior.requestId === row.requestId;
    const priorMatchesNext =
      prior.status === row.status
      && Boolean(prior.confirmedTransfer) === Boolean(row.confirmedTransfer)
      && prior.requestId === row.requestId
      && (prior.liveOwnership?.storeOnlyWorkerId || null) === (row.liveOwnership?.storeOnlyWorkerId || null);

    if (sameRequest && prior.confirmedTransfer && row.status === 'unresolved') {
      history.push({...prior, reason: prior.reason || 'historical_success_unverified'});
      current.push({
        ...row,
        confirmedTransfer: false,
        reason: row.reason || 'network_or_unknown',
        message: row.message || '先前成功回执已归档；本次网络结果未核实，不能记作当前归属',
      });
      continue;
    }

    if (!priorMatchesNext) history.push(prior);
    // Fresh authoritative outcomes always win for the current batch — including
    // existing_stale / ownership mismatch superseding an older confirmed transfer.
    current.push(row);
  }

  for (const prior of prevRows) {
    if (!nextByDemand.has(prior.demandId)) history.push(prior);
  }

  return {current, history};
}

/** Summarize only the current frozen-batch receipts (never the audit history). */
export function summarizeCurrentBatch(
  previous: TransferResultRow[] | null | undefined,
  next: TransferResultRow[] | null | undefined,
) {
  const {current, history} = mergeReceipts(previous, next);
  return {current, history, summary: summarizeTransferResults(current)};
}

export function storageKey(orgId: string) {
  return 'rssd:store-only-transfer:' + orgId;
}

export async function loadDemandsByIds(api: (path: string) => Promise<any>, ids: string[]) {
  const wanted = new Set(ids);
  const found = new Map<string, any>();
  let offset = 0;
  const limit = 200;
  for (;;) {
    const page = await api(
      `/demands?states=queued,claimed,blocked,completed,cancelled&limit=${limit}&offset=${offset}&withTotal=true`,
    );
    const items = Array.isArray(page) ? page : page.items || [];
    for (const row of items) {
      if (wanted.has(row.id)) found.set(row.id, row);
    }
    offset += items.length;
    const total = Array.isArray(page) ? offset : Number(page.total || offset);
    if (!items.length || found.size === wanted.size || offset >= total) break;
    if (offset > Math.max(total, ids.length) + limit) break;
  }
  return found;
}

async function sha256Hex(text: string) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto subtle API is required to build transfer request ids');
  const bytes = new TextEncoder().encode(text);
  const digest = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
