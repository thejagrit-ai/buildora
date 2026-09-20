import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { Plus, Trash2, X, Send, FileText, Check, RefreshCw } from 'lucide-react';
import { api, apiErrorMessage } from '../api/client';
import { PageHeader, Card, StatusBadge, Spinner, Field, Modal } from '../components/ui';
import { DataTable, Column } from '../components/DataTable';
import { formatPaise } from '../lib/money';
import { useAuth } from '../store/auth';

const STATUS_OPTIONS = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'];
const CATEGORIES = ['BSP', 'PLC', 'FLOOR_RISE', 'PARKING', 'CLUB_HOUSE', 'INFRA', 'STAMP_DUTY'] as const;
type Category = (typeof CATEGORIES)[number];

interface LineItem {
  label: string;
  category: Category;
  quantity: number;
  rateRupees: number;
  gstRate: number;
  isInformational: boolean;
}

function accountName(q: any): string {
  return q.account?.name ?? q.accountName ?? '—';
}

export default function Quotations() {
  const can = useAuth((s) => s.can);
  const [alert, setAlert] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const listQ = useQuery({
    queryKey: ['quotations', statusFilter],
    queryFn: async () =>
      (await api.get('/quotations', {
        params: { limit: 100, ...(statusFilter ? { status: statusFilter } : {}) },
      })).data,
  });
  const quotes: any[] = listQ.data?.data ?? [];

  const columns: Column<any>[] = [
    { key: 'quoteNumber', header: 'Quote #', render: (q) => <span className="font-medium text-slate-800">{q.quoteNumber}</span> },
    { key: 'account', header: 'Account', render: accountName },
    { key: 'status', header: 'Status', render: (q) => <StatusBadge status={q.status} /> },
    { key: 'totalPaise', header: 'Total', render: (q) => formatPaise(q.totalPaise) },
    { key: 'version', header: 'Ver.', render: (q) => `v${q.version ?? 1}` },
    { key: 'validUntil', header: 'Valid Until', render: (q) => (q.validUntil ? dayjs(q.validUntil).format('DD MMM YYYY') : '—') },
  ];

  return (
    <div>
      <PageHeader
        title="Quotations"
        subtitle="Generate, send and track cost sheets"
        actions={
          can('quotations.create') && (
            <button className="btn-primary flex items-center gap-1.5" onClick={() => setShowNew(true)}>
              <Plus className="h-4 w-4" /> New Quotation
            </button>
          )
        }
      />

      {alert && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <span>{alert}</span>
          <button className="text-rose-400 hover:text-rose-600" onClick={() => setAlert(null)}>✕</button>
        </div>
      )}

      <Card className="mb-6">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Status">
            <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </Field>
          {statusFilter && <button className="btn-ghost" onClick={() => setStatusFilter('')}>Clear</button>}
        </div>
      </Card>

      <DataTable
        columns={columns}
        rows={quotes}
        loading={listQ.isLoading}
        onRowClick={(q) => setDetailId(q.id)}
        emptyTitle="No quotations"
        emptyHint="Create a quotation to share a cost sheet with a client."
      />

      {showNew && <NewQuotationModal onClose={() => setShowNew(false)} onError={setAlert} />}
      {detailId && <QuotationDrawer id={detailId} onClose={() => setDetailId(null)} onError={setAlert} />}
    </div>
  );
}

function blankItem(): LineItem {
  return { label: '', category: 'BSP', quantity: 1, rateRupees: 0, gstRate: 5, isInformational: false };
}

function NewQuotationModal({ onClose, onError }: { onClose: () => void; onError: (m: string) => void }) {
  const qc = useQueryClient();
  const [accountId, setAccountId] = useState('');
  const [opportunityId, setOpportunityId] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [items, setItems] = useState<LineItem[]>([blankItem()]);

  const accountsQ = useQuery({
    queryKey: ['accounts', 'select'],
    queryFn: async () => (await api.get('/accounts', { params: { limit: 200 } })).data,
  });
  const accounts: any[] = accountsQ.data?.data ?? accountsQ.data ?? [];

  const totals = useMemo(() => {
    let subtotal = 0;
    let gst = 0;
    for (const it of items) {
      if (it.isInformational) continue;
      const line = (Number(it.quantity) || 0) * (Number(it.rateRupees) || 0);
      subtotal += line;
      gst += (line * (Number(it.gstRate) || 0)) / 100;
    }
    return { subtotal, gst, total: subtotal + gst };
  }, [items]);

  const createMut = useMutation({
    mutationFn: async () => {
      const body: any = {
        accountId,
        validUntil,
        lineItems: items.map((it) => ({
          label: it.label,
          category: it.category,
          quantity: Number(it.quantity) || 0,
          rateRupees: Number(it.rateRupees) || 0,
          gstRate: Number(it.gstRate) || 0,
          isInformational: it.isInformational,
        })),
      };
      if (opportunityId.trim()) body.opportunityId = opportunityId.trim();
      return (await api.post('/quotations', body)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['quotations'] });
      onClose();
    },
    onError: (e) => onError(apiErrorMessage(e)),
  });

  function updateItem(i: number, patch: Partial<LineItem>) {
    setItems((arr) => arr.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }

  const valid = accountId && validUntil && items.length > 0 && items.every((it) => it.label.trim());

  return (
    <Modal
      open
      onClose={onClose}
      title="New Quotation"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!valid || createMut.isPending} onClick={() => createMut.mutate()}>
            {createMut.isPending ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Account">
            <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Select account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Valid until">
            <input className="input" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </Field>
        </div>
        <Field label="Opportunity ID (optional)">
          <input className="input" value={opportunityId} onChange={(e) => setOpportunityId(e.target.value)} placeholder="Linked opportunity" />
        </Field>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="label mb-0">Line items</span>
            <button className="btn-outline flex items-center gap-1 px-2 py-1 text-xs" onClick={() => setItems((a) => [...a, blankItem()])}>
              <Plus className="h-3.5 w-3.5" /> Add row
            </button>
          </div>
          <div className="space-y-2">
            {items.map((it, i) => (
              <div key={i} className="rounded-lg border border-slate-200 p-3">
                <div className="grid grid-cols-12 gap-2">
                  <input
                    className="input col-span-12 md:col-span-4"
                    placeholder="Label"
                    value={it.label}
                    onChange={(e) => updateItem(i, { label: e.target.value })}
                  />
                  <select
                    className="input col-span-6 md:col-span-3"
                    value={it.category}
                    onChange={(e) => updateItem(i, { category: e.target.value as Category })}
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>
                    ))}
                  </select>
                  <input
                    className="input col-span-3 md:col-span-1"
                    type="number"
                    min="0"
                    placeholder="Qty"
                    value={it.quantity}
                    onChange={(e) => updateItem(i, { quantity: Number(e.target.value) })}
                  />
                  <input
                    className="input col-span-6 md:col-span-2"
                    type="number"
                    min="0"
                    placeholder="Rate ₹"
                    value={it.rateRupees}
                    onChange={(e) => updateItem(i, { rateRupees: Number(e.target.value) })}
                  />
                  <input
                    className="input col-span-3 md:col-span-1"
                    type="number"
                    min="0"
                    placeholder="GST%"
                    value={it.gstRate}
                    onChange={(e) => updateItem(i, { gstRate: Number(e.target.value) })}
                  />
                  <button
                    className="col-span-3 flex items-center justify-center text-slate-400 hover:text-rose-600 md:col-span-1"
                    onClick={() => setItems((a) => a.filter((_, idx) => idx !== i))}
                    disabled={items.length === 1}
                    title="Remove"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={it.isInformational}
                    onChange={(e) => updateItem(i, { isInformational: e.target.checked })}
                  />
                  Informational only (excluded from total)
                </label>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg bg-slate-50 px-4 py-3 text-sm">
          <div className="flex justify-between text-slate-600">
            <span>Subtotal</span>
            <span>₹{totals.subtotal.toLocaleString('en-IN')}</span>
          </div>
          <div className="flex justify-between text-slate-600">
            <span>GST</span>
            <span>₹{totals.gst.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
          </div>
          <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 font-semibold text-slate-800">
            <span>Total</span>
            <span>₹{totals.total.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function QuotationDrawer({ id, onClose, onError }: { id: string; onClose: () => void; onError: (m: string) => void }) {
  const qc = useQueryClient();
  const detailQ = useQuery({
    queryKey: ['quotations', id],
    queryFn: async () => (await api.get(`/quotations/${id}`)).data,
  });
  const q = detailQ.data;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['quotations'] });
    qc.invalidateQueries({ queryKey: ['quotations', id] });
  };

  const sendMut = useMutation({
    mutationFn: async () => (await api.post(`/quotations/${id}/send`, {})).data,
    onSuccess: invalidate,
    onError: (e) => onError(apiErrorMessage(e)),
  });
  const acceptMut = useMutation({
    mutationFn: async () => (await api.post(`/quotations/${id}/accept`, {})).data,
    onSuccess: invalidate,
    onError: (e) => onError(apiErrorMessage(e)),
  });
  const reviseMut = useMutation({
    mutationFn: async () => (await api.post(`/quotations/${id}/revise`, {})).data,
    onSuccess: invalidate,
    onError: (e) => onError(apiErrorMessage(e)),
  });
  const pdfMut = useMutation({
    mutationFn: async () => (await api.get(`/quotations/${id}/pdf`)).data,
    onSuccess: (data: any) => {
      const w = window.open('', '_blank');
      if (w) {
        w.document.write(data?.html ?? '<p>No content</p>');
        w.document.close();
      }
    },
    onError: (e) => onError(apiErrorMessage(e)),
  });

  const items: any[] = q?.lineItems ?? [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
      <div className="flex h-full w-full max-w-xl flex-col bg-surface shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <div>
            <h3 className="font-semibold text-slate-800">{q?.quoteNumber ?? 'Quotation'}</h3>
            {q && <p className="text-xs text-slate-500">{accountName(q)} · v{q.version ?? 1}</p>}
          </div>
          <button className="text-slate-400 hover:text-slate-600" onClick={onClose}>
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {detailQ.isLoading ? (
            <Spinner />
          ) : !q ? (
            <p className="text-sm text-slate-400">Not found.</p>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
                <StatusBadge status={q.status} />
                {q.validUntil && <span className="text-slate-500">Valid until {dayjs(q.validUntil).format('DD MMM YYYY')}</span>}
              </div>

              <div className="overflow-hidden rounded-lg border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="th">Label</th>
                      <th className="th">Category</th>
                      <th className="th">Qty</th>
                      <th className="th">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map((it, i) => (
                      <tr key={it.id ?? i} className={it.isInformational ? 'text-slate-400' : ''}>
                        <td className="td">{it.label}{it.isInformational && <span className="ml-1 text-xs">(info)</span>}</td>
                        <td className="td">{String(it.category ?? '').replace(/_/g, ' ')}</td>
                        <td className="td">{it.quantity}</td>
                        <td className="td">{formatPaise(it.amountPaise ?? it.totalPaise ?? '0')}</td>
                      </tr>
                    ))}
                    {items.length === 0 && (
                      <tr><td className="td text-slate-400" colSpan={4}>No line items.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 rounded-lg bg-slate-50 px-4 py-3 text-sm">
                <div className="flex justify-between text-slate-600">
                  <span>Subtotal</span>
                  <span>{formatPaise(q.subtotalPaise ?? '0')}</span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>GST</span>
                  <span>{formatPaise(q.gstPaise ?? q.taxPaise ?? '0')}</span>
                </div>
                {q.discountPaise && Number(q.discountPaise) > 0 && (
                  <div className="flex justify-between text-slate-600">
                    <span>Discount</span>
                    <span>- {formatPaise(q.discountPaise)}</span>
                  </div>
                )}
                <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 font-semibold text-slate-800">
                  <span>Total</span>
                  <span>{formatPaise(q.totalPaise ?? '0')}</span>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t px-5 py-3">
          <button className="btn-outline flex items-center gap-1.5" disabled={pdfMut.isPending} onClick={() => pdfMut.mutate()}>
            <FileText className="h-4 w-4" /> View PDF
          </button>
          <button className="btn-outline flex items-center gap-1.5" disabled={sendMut.isPending} onClick={() => sendMut.mutate()}>
            <Send className="h-4 w-4" /> Send
          </button>
          <button className="btn-outline flex items-center gap-1.5" disabled={reviseMut.isPending} onClick={() => reviseMut.mutate()}>
            <RefreshCw className="h-4 w-4" /> Revise
          </button>
          <button className="btn-primary flex items-center gap-1.5" disabled={acceptMut.isPending} onClick={() => acceptMut.mutate()}>
            <Check className="h-4 w-4" /> Accept
          </button>
        </div>
      </div>
    </div>
  );
}
