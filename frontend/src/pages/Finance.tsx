import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiErrorMessage } from '../api/client';
import { PageHeader, Card, StatCard, StatusBadge, Spinner, Field, Modal, EmptyState } from '../components/ui';
import { DataTable, Column } from '../components/DataTable';
import { formatPaise } from '../lib/money';
import { useAuth } from '../store/auth';

const PAYMENT_MODES = ['NEFT', 'RTGS', 'CHEQUE', 'UPI', 'DD'];
const TABS = ['Outstanding', 'By Booking'] as const;
type Tab = (typeof TABS)[number];

function openHtmlWindow(html: string) {
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
}

export default function Finance() {
  const [tab, setTab] = useState<Tab>('Outstanding');

  return (
    <div>
      <PageHeader title="Finance" subtitle="Demands, collections and receipts" />

      <div className="mb-5 flex gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t}
            className={`px-3 py-2 text-sm font-medium ${tab === t ? 'border-b-2 border-brand-600 text-brand-700' : 'text-slate-500 hover:text-slate-700'}`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Outstanding' ? <OutstandingTab /> : <ByBookingTab />}
    </div>
  );
}

// ─────────────────────────── Outstanding ───────────────────────────

function OutstandingTab() {
  const overdue = useQuery({
    queryKey: ['demands-overdue'],
    queryFn: async () => (await api.get('/demands/overdue')).data as { data: any[]; meta: any },
  });

  const letterMut = useMutation({
    mutationFn: async (demandId: string) => (await api.get(`/demands/${demandId}/letter`)).data as { html: string },
    onSuccess: (d) => { if (d?.html) openHtmlWindow(d.html); },
  });

  const columns: Column<any>[] = [
    { key: 'demandNumber', header: 'Demand #', render: (r) => <span className="font-medium text-slate-900">{r.demandNumber ?? r.code ?? '—'}</span> },
    { key: 'booking', header: 'Booking', render: (r) => r.booking?.bookingNumber ?? r.bookingNumber ?? '—' },
    { key: 'totalPaise', header: 'Total', render: (r) => formatPaise(r.totalPaise) },
    { key: 'paidPaise', header: 'Paid', render: (r) => formatPaise(r.paidPaise) },
    { key: 'dueDate', header: 'Due', render: (r) => (r.dueDate ? new Date(r.dueDate).toLocaleDateString('en-IN') : '—') },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', header: '', render: (r) => (
        <button className="btn-outline !py-1 !text-xs" onClick={() => letterMut.mutate(r.id)}>Demand Letter</button>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={overdue.data?.data}
      loading={overdue.isLoading}
      emptyTitle="Nothing overdue"
      emptyHint="All demands are within their due dates."
    />
  );
}

// ─────────────────────────── By Booking ───────────────────────────

function ByBookingTab() {
  const queryClient = useQueryClient();
  const can = useAuth((s) => s.can);
  const canDemand = can('finance.demand');
  const canReceipt = can('finance.receipt');

  const [bookingId, setBookingId] = useState('');
  const [showDemand, setShowDemand] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const [showReceipt, setShowReceipt] = useState(false);

  const bookings = useQuery({
    queryKey: ['bookings', 'finance'],
    queryFn: async () => (await api.get('/bookings')).data as { data: any[]; meta: any },
  });

  const ledger = useQuery({
    queryKey: ['ledger', bookingId],
    enabled: !!bookingId,
    queryFn: async () => (await api.get(`/bookings/${bookingId}/ledger`)).data,
  });

  const invalidateLedger = () => queryClient.invalidateQueries({ queryKey: ['ledger', bookingId] });

  const letterMut = useMutation({
    mutationFn: async (demandId: string) => (await api.get(`/demands/${demandId}/letter`)).data as { html: string },
    onSuccess: (d) => { if (d?.html) openHtmlWindow(d.html); },
  });

  const pdfMut = useMutation({
    mutationFn: async (receiptId: string) => (await api.get(`/receipts/${receiptId}/pdf`)).data as { html: string },
    onSuccess: (d) => { if (d?.html) openHtmlWindow(d.html); },
  });

  const l = ledger.data;
  const demands: any[] = l?.demands ?? [];
  const receipts: any[] = l?.receipts ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-72">
          <span className="label">Booking</span>
          <select className="input" value={bookingId} onChange={(e) => setBookingId(e.target.value)}>
            <option value="">Select booking…</option>
            {(bookings.data?.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.bookingNumber ?? b.code ?? b.id} — {b.account?.name ?? b.accountName ?? ''}
              </option>
            ))}
          </select>
        </div>
        {bookingId && (
          <div className="flex gap-2">
            {canDemand && <button className="btn-outline" onClick={() => setShowDemand(true)}>Generate Demand</button>}
            {canDemand && <button className="btn-outline" onClick={() => setShowPlan(true)}>Generate from Plan</button>}
            {canReceipt && <button className="btn-primary" onClick={() => setShowReceipt(true)}>Record Receipt</button>}
          </div>
        )}
      </div>

      {!bookingId ? (
        <EmptyState title="Select a booking" hint="Choose a booking to view its ledger." />
      ) : ledger.isLoading ? (
        <Spinner />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard label="Total Demanded" value={formatPaise(l?.totalDemandedPaise ?? '0')} />
            <StatCard label="Total Paid" value={formatPaise(l?.totalPaidPaise ?? '0')} />
            <StatCard label="Balance" value={formatPaise(l?.balancePaise ?? '0')} />
          </div>

          <Card>
            <h3 className="mb-3 font-semibold text-slate-800">Demands</h3>
            {demands.length === 0 ? (
              <p className="text-sm text-slate-400">No demands raised.</p>
            ) : (
              <div className="space-y-2">
                {demands.map((d, i) => (
                  <div key={d.id ?? i} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5 text-sm">
                    <div>
                      <div className="font-medium text-slate-800">{d.demandNumber ?? d.milestoneLabel ?? 'Demand'}</div>
                      <div className="text-xs text-slate-500">
                        {d.milestoneLabel ?? '—'} · Due {d.dueDate ? new Date(d.dueDate).toLocaleDateString('en-IN') : '—'}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-medium text-slate-800">{formatPaise(d.totalPaise ?? d.amountPaise)}</span>
                      <StatusBadge status={d.status} />
                      <button className="btn-outline !py-1 !text-xs" onClick={() => letterMut.mutate(d.id)}>Demand Letter</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <h3 className="mb-3 font-semibold text-slate-800">Receipts</h3>
            {receipts.length === 0 ? (
              <p className="text-sm text-slate-400">No receipts recorded.</p>
            ) : (
              <div className="space-y-2">
                {receipts.map((r, i) => (
                  <div key={r.id ?? i} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5 text-sm">
                    <div>
                      <div className="font-medium text-slate-800">{r.receiptNumber ?? r.number ?? 'Receipt'}</div>
                      <div className="text-xs text-slate-500">
                        {r.mode ?? '—'} · {r.receivedAt ? new Date(r.receivedAt).toLocaleDateString('en-IN') : '—'}
                        {r.bankReference ? ` · ${r.bankReference}` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-medium text-slate-800">{formatPaise(r.amountPaise)}</span>
                      <button className="btn-outline !py-1 !text-xs" onClick={() => pdfMut.mutate(r.id)}>Receipt PDF</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      {showDemand && <GenerateDemandModal bookingId={bookingId} onClose={() => setShowDemand(false)} onDone={invalidateLedger} />}
      {showPlan && <FromPlanModal bookingId={bookingId} onClose={() => setShowPlan(false)} onDone={invalidateLedger} />}
      {showReceipt && <RecordReceiptModal bookingId={bookingId} onClose={() => setShowReceipt(false)} onDone={invalidateLedger} />}
    </div>
  );
}

// ─────────────────────────── Modals ───────────────────────────

function GenerateDemandModal({ bookingId, onClose, onDone }: { bookingId: string; onClose: () => void; onDone: () => void }) {
  const [milestoneLabel, setMilestoneLabel] = useState('');
  const [amountRupees, setAmountRupees] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState('');

  const mut = useMutation({
    mutationFn: async () =>
      (await api.post(`/bookings/${bookingId}/demands`, {
        milestoneLabel,
        amountRupees: Number(amountRupees),
        dueDate: dueDate || undefined,
      })).data,
    onSuccess: () => { onDone(); onClose(); },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Generate Demand"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!milestoneLabel || !amountRupees || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? 'Saving…' : 'Generate'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}
        <Field label="Milestone label">
          <input className="input" value={milestoneLabel} placeholder="On booking / On foundation" onChange={(e) => setMilestoneLabel(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount (₹)">
            <input className="input" type="number" min={0} value={amountRupees} onChange={(e) => setAmountRupees(e.target.value)} />
          </Field>
          <Field label="Due date">
            <input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function FromPlanModal({ bookingId, onClose, onDone }: { bookingId: string; onClose: () => void; onDone: () => void }) {
  const [planId, setPlanId] = useState('');
  const [error, setError] = useState('');

  const plans = useQuery({
    queryKey: ['payment-plans'],
    queryFn: async () => (await api.get('/payment-plans')).data as { data: any[]; meta: any },
  });

  const mut = useMutation({
    mutationFn: async () => (await api.post(`/bookings/${bookingId}/demands/from-plan`, { planId })).data,
    onSuccess: () => { onDone(); onClose(); },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Generate from Payment Plan"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!planId || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? 'Generating…' : 'Generate'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}
        {plans.isLoading ? <Spinner /> : (
          <Field label="Payment plan">
            <select className="input" value={planId} onChange={(e) => setPlanId(e.target.value)}>
              <option value="">Select plan…</option>
              {(plans.data?.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name ?? p.label ?? p.id}</option>
              ))}
            </select>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function RecordReceiptModal({ bookingId, onClose, onDone }: { bookingId: string; onClose: () => void; onDone: () => void }) {
  const [amountRupees, setAmountRupees] = useState('');
  const [mode, setMode] = useState('NEFT');
  const [bankReference, setBankReference] = useState('');
  const [receivedAt, setReceivedAt] = useState('');
  const [allowAdvance, setAllowAdvance] = useState(false);
  const [error, setError] = useState('');

  const mut = useMutation({
    mutationFn: async () =>
      (await api.post(`/bookings/${bookingId}/receipts`, {
        amountRupees: Number(amountRupees),
        mode,
        bankReference: bankReference || undefined,
        receivedAt: receivedAt || undefined,
        allowAdvance,
      })).data,
    onSuccess: () => { onDone(); onClose(); },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Record Receipt"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!amountRupees || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? 'Saving…' : 'Record'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount (₹)">
            <input className="input" type="number" min={0} value={amountRupees} onChange={(e) => setAmountRupees(e.target.value)} />
          </Field>
          <Field label="Mode">
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
              {PAYMENT_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Bank reference">
          <input className="input" value={bankReference} onChange={(e) => setBankReference(e.target.value)} />
        </Field>
        <Field label="Received at">
          <input className="input" type="datetime-local" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={allowAdvance} onChange={(e) => setAllowAdvance(e.target.checked)} />
          Allow advance (accept beyond demanded amount)
        </label>
      </div>
    </Modal>
  );
}
