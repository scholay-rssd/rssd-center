'use client';
// Owner-only bulk handoff of queued store-only translate demands.
// Shows metadata and CAS fields only — never manuscript bodies or private drafts.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import type { RssdApi } from './api';
import { ApiError } from './api';
import {
  classifyTransferOutcome,
  freezePreviewRow,
  loadDemandsByIds,
  mergeReceipts,
  parseDemandIds,
  previewIsCurrent,
  stableTransferRequestId,
  storageKey,
  summarizeTransferResults,
} from './store-only-transfer-logic';

export { loadDemandsByIds };

type Row = Record<string, any>;
type PreviewRow = Row & { requestId?: string };
type ResultRow = {
  demandId: string;
  status: string;
  reason?: string;
  message?: string;
  confirmedTransfer?: boolean;
  liveOwnership?: Row;
  requestId?: string;
};

const reasonLabel: Record<string, string> = {
  not_store_only: '不是仅存英文任务',
  claimed_or_blocked: '已认领或阻塞',
  not_queued: '不在排队',
  missing_creator: '缺少创建设备',
  already_target: '已属于目标设备',
  missing: '清单中未找到',
  forbidden: '目标设备无该工作空间',
  historical_replay_not_current_owner: '历史回放，当前所有者不是目标设备',
  live_ownership_mismatch: '回执与当前所有者不一致',
  network_or_unknown: '网络中断或未知结果',
};

export function StoreOnlyTransferPanel({ api, registry, workers }: { api: RssdApi; registry: Row[]; workers: Row[] }) {
  const user = useUser();
  const orgId = user?.orgId || 'local';
  const [rawIds, setRawIds] = useState('');
  const [toWorkerId, setToWorkerId] = useState('');
  const [frozen, setFrozen] = useState<{ rawIds: string; toWorkerId: string; preview: PreviewRow[] } | null>(null);
  const [results, setResults] = useState<ResultRow[] | null>(null);
  const [history, setHistory] = useState<ResultRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey(orgId)) || 'null');
      if (!saved || typeof saved !== 'object') return;
      if (typeof saved.rawIds === 'string') setRawIds(saved.rawIds);
      if (typeof saved.toWorkerId === 'string') setToWorkerId(saved.toWorkerId);
      if (saved.frozen && previewIsCurrent(saved.frozen, saved.rawIds, saved.toWorkerId)) setFrozen(saved.frozen);
      if (Array.isArray(saved.results)) setResults(saved.results);
      if (Array.isArray(saved.history)) setHistory(saved.history);
    } catch {
      /* ignore corrupt local recovery state */
    }
  }, [orgId]);

  const persist = useCallback((next: {
    rawIds?: string;
    toWorkerId?: string;
    frozen?: { rawIds: string; toWorkerId: string; preview: PreviewRow[] } | null;
    results?: ResultRow[] | null;
    history?: ResultRow[];
  }) => {
    const payload = {
      rawIds: next.rawIds ?? rawIds,
      toWorkerId: next.toWorkerId ?? toWorkerId,
      frozen: next.frozen === undefined ? frozen : next.frozen,
      results: next.results === undefined ? results : next.results,
      history: next.history === undefined ? history : next.history,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(storageKey(orgId), JSON.stringify(payload));
  }, [orgId, frozen, history, rawIds, results, toWorkerId]);

  const eligibleWorkers = useMemo(
    () => (workers || []).filter((row) => !row.revokedAt && Array.isArray(row.workspaceIds) && row.workspaceIds.length),
    [workers],
  );

  const previewCurrent = previewIsCurrent(frozen, rawIds, toWorkerId);
  const preview = previewCurrent ? frozen?.preview || null : null;
  const transferable = (preview || []).filter((row) => row.action === 'transfer').length;

  const onEditSelection = (nextRawIds: string, nextToWorkerId: string) => {
    setRawIds(nextRawIds);
    setToWorkerId(nextToWorkerId);
    // Invalidate actionable preview when the visible selection diverges; keep receipts for recovery.
    if (frozen && (frozen.rawIds !== nextRawIds || frozen.toWorkerId !== nextToWorkerId)) {
      setFrozen(null);
      setNotice('清单或目标设备已更改，旧预览已失效。请重新预览后再执行。已完成的回执仍保留。');
      persist({ rawIds: nextRawIds, toWorkerId: nextToWorkerId, frozen: null, results });
    } else {
      persist({ rawIds: nextRawIds, toWorkerId: nextToWorkerId });
    }
  };

  const buildPreview = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const ids = parseDemandIds(rawIds);
      if (!ids.length) throw new Error('请粘贴至少一个任务编号');
      if (!toWorkerId) throw new Error('请选择目标设备');
      const target = eligibleWorkers.find((row) => row.id === toWorkerId);
      if (!target) throw new Error('目标设备不可用');
      const found = await loadDemandsByIds(api, ids);
      const rows: PreviewRow[] = [];
      for (const id of ids) {
        const demand = found.get(id);
        if (!demand) {
          rows.push({ demandId: id, action: 'skip', reason: 'missing', title: '' });
          continue;
        }
        if (!target.workspaceIds.includes(demand.workspaceId)) {
          rows.push({
            demandId: id,
            action: 'skip',
            reason: 'forbidden',
            title: demand.title || '',
            state: demand.state,
            workspaceId: demand.workspaceId,
          });
          continue;
        }
        const next = freezePreviewRow(demand, toWorkerId);
        if (next.action === 'transfer') {
          const requestId = await stableTransferRequestId({
            demandId: next.demandId,
            expectedGeneration: next.expectedGeneration,
            expectedStoreOnlyWorkerId: next.expectedStoreOnlyWorkerId,
            toWorkerId,
          });
          rows.push({ ...next, requestId });
        } else {
          rows.push(next);
        }
      }
      // Only the pasted ID list appears in the frozen preview — never transfer outside it.
      const nextFrozen = { rawIds, toWorkerId, preview: rows };
      setFrozen(nextFrozen);
      persist({ rawIds, toWorkerId, frozen: nextFrozen, results });
      setNotice(`已冻结预览 ${rows.length} 条（仅元数据；目标设备已锁定）。请核对后再执行移交。`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runTransfers = async () => {
    if (!previewCurrent || !frozen?.preview?.length) return;
    if (frozen.toWorkerId !== toWorkerId || frozen.rawIds !== rawIds) {
      setError('预览与当前清单/目标不一致，已禁止执行。请重新预览。');
      return;
    }
    setBusy(true); setError(''); setNotice('');
    const out: ResultRow[] = [];
    try {
      for (const row of frozen.preview) {
        if (row.action !== 'transfer') {
          out.push({ demandId: row.demandId, status: 'skipped', reason: row.reason, confirmedTransfer: false });
          continue;
        }
        try {
          const receipt = await api(`/demands/${encodeURIComponent(row.demandId)}/transfer-store-only`, 'POST', {
            requestId: row.requestId,
            expectedGeneration: row.expectedGeneration,
            expectedStoreOnlyWorkerId: row.expectedStoreOnlyWorkerId,
            toWorkerId: row.toWorkerId,
            expectedState: 'queued',
          });
          const classified = classifyTransferOutcome({ receipt, toWorkerId: row.toWorkerId });
          out.push({
            demandId: row.demandId,
            requestId: row.requestId,
            status: classified.status,
            reason: classified.reason,
            confirmedTransfer: classified.confirmedTransfer,
            liveOwnership: classified.liveOwnership,
          });
        } catch (e) {
          const networkFailed = !(e instanceof ApiError);
          const classified = classifyTransferOutcome({
            error: e instanceof ApiError ? e : { code: 'network', message: e instanceof Error ? e.message : String(e) },
            toWorkerId: row.toWorkerId,
            networkFailed,
          });
          out.push({
            demandId: row.demandId,
            requestId: row.requestId,
            status: classified.status,
            reason: classified.reason,
            message: classified.message || (e instanceof Error ? e.message : String(e)),
            confirmedTransfer: false,
          });
        }
      }
      const { current, history: archived } = mergeReceipts(results, out);
      const nextHistory = archived.length ? [...history, ...archived] : history;
      setResults(current);
      setHistory(nextHistory);
      persist({ frozen, results: current, history: nextHistory });
      const summary = summarizeTransferResults(current);
      if (summary.allTransferred) {
        setNotice(`全部可移交项已确认归属目标设备：确认 ${summary.confirmedTransfers}，跳过 ${summary.skipped}。`);
      } else if (summary.completedWithoutErrors) {
        setNotice(`批次无冲突/错误，但未全部移交：确认 ${summary.confirmedTransfers}，跳过 ${summary.skipped}。跳过不算已移交。`);
      } else {
        setError(`存在失败或不确定项：确认 ${summary.confirmedTransfers}，跳过 ${summary.skipped}，冲突 ${summary.conflict}，错误 ${summary.error}，不确定 ${summary.unresolved}，历史过期重放 ${summary.existingStale}。不能记作全部移交成功。可用同一 requestId 重试不确定项。`);
      }
    } finally {
      setBusy(false);
    }
  };

  const summary = results ? summarizeTransferResults(results) : null;
  const frozenTargetName = eligibleWorkers.find((row) => row.id === frozen?.toWorkerId)?.name || frozen?.toWorkerId;

  return (
    <section className="ca-subpanel" aria-label="仅存英文任务移交">
      <div className="cp-section-heading">
        <div>
          <h3>仅存英文任务移交</h3>
          <p>Owner 将会话内排队中的仅存英文任务原子移交给指定设备。预览只读元数据与来源指纹；执行使用冻结的 generation 与创建设备，不改来源、不取消重建。</p>
        </div>
      </div>
      {error && <p role="alert" className="cp-notice ca-error">{error}</p>}
      {notice && <p role="status" className="cp-notice">{notice}</p>}
      <div className="cp-detail-form ca-form">
        <label>目标设备
          <select
            value={toWorkerId}
            onChange={(event) => onEditSelection(rawIds, event.target.value)}
            disabled={busy}
          >
            <option value="">选择有工作空间范围的设备</option>
            {eligibleWorkers.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name} · {(row.workspaceIds || []).map((id: string) => registry.find((w) => w.id === id)?.name || id).join('、')}
              </option>
            ))}
          </select>
        </label>
        <label>任务编号清单（每行一个，可粘贴）
          <textarea
            rows={8}
            value={rawIds}
            disabled={busy}
            placeholder="tr-…"
            onChange={(event) => onEditSelection(event.target.value, toWorkerId)}
          />
        </label>
        {frozen && previewCurrent && (
          <p className="cp-muted" role="status">
            冻结目标：<strong>{frozenTargetName}</strong> · 冻结清单 {frozen.preview.length} 条 · 可移交 {transferable} 条。修改清单或目标会使预览失效。
          </p>
        )}
        {!previewCurrent && frozen === null && results?.length ? (
          <p className="cp-muted">已保留历史回执；当前无可执行预览。</p>
        ) : null}
        <div className="ca-actions">
          <button type="button" className="cp-primary" disabled={busy} onClick={() => void buildPreview()}>预览并冻结</button>
          <button
            type="button"
            disabled={busy || !previewCurrent || transferable === 0}
            onClick={() => void runTransfers()}
          >
            对冻结预览中的 {transferable} 条执行移交
          </button>
        </div>
      </div>
      {preview && (
        <div className="cp-table-wrap">
          <table className="cp-demands-table">
            <thead>
              <tr>
                <th>任务</th>
                <th>状态</th>
                <th>generation</th>
                <th>创建设备</th>
                <th>来源修订</th>
                <th>动作</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((row) => (
                <tr key={row.demandId}>
                  <td>
                    <strong>{row.demandId}</strong>
                    {row.title ? <small>{row.title}</small> : null}
                    {row.workspaceId ? <small>{row.workspaceId}/{row.sectionId}</small> : null}
                  </td>
                  <td>{row.state || '—'}</td>
                  <td>{row.expectedGeneration ?? '—'}</td>
                  <td><code>{row.expectedStoreOnlyWorkerId ? String(row.expectedStoreOnlyWorkerId).slice(0, 8) : '—'}</code></td>
                  <td>
                    {row.source ? `${row.source.locale}@${row.source.revision}` : '—'}
                    {row.sourceHash ? <small>{String(row.sourceHash).slice(0, 12)}</small> : null}
                  </td>
                  <td>{row.action === 'transfer' ? '移交' : `跳过（${reasonLabel[row.reason] || row.reason || '—'}）`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {results && summary && (
        <div className="cp-table-wrap">
          <p className="cp-muted">
            当前批次结果：确认移交 {summary.transferred + summary.existingConfirmed}
            （新移交 {summary.transferred} · 已确认重放 {summary.existingConfirmed}）
            · 跳过 {summary.skipped}
            · 冲突 {summary.conflict}
            · 错误 {summary.error}
            · 不确定 {summary.unresolved}
            · 过期重放 {summary.existingStale}
            {summary.allTransferred ? ' · 可移交项已全部确认' : ' · 尚未全部移交（跳过不算已移交）'}
            {history.length ? ` · 审计历史 ${history.length} 条（不计入当前汇总）` : ''}
          </p>
          <table className="cp-demands-table">
            <thead><tr><th>任务</th><th>结果</th><th>说明</th></tr></thead>
            <tbody>
              {results.map((row) => (
                <tr key={`${row.demandId}:${row.requestId || row.status}`}>
                  <td><code>{row.demandId}</code></td>
                  <td>{row.status}{row.confirmedTransfer ? ' ✓' : ''}</td>
                  <td>{row.message || reasonLabel[row.reason || ''] || row.reason || (row.liveOwnership ? `live ${String(row.liveOwnership.storeOnlyWorkerId || '').slice(0, 8)}@${row.liveOwnership.generation}` : '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
