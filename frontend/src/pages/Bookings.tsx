import { ReactNode, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api, apiErrorMessage } from '../api/client';
import { PageHeader, Card, StatusBadge, Spinner, Field, Modal, EmptyState } from '../components/ui';
import { DataTable, Column } from '../components/DataTable';
import { formatPaise } from '../lib/money';

const BOOKING_STATUSES = ['INITIATED', 'AMOUNT_RECEIVED', 'AGREEMENT_SENT', 'AGREEMENT_SIGNED', 'CONFIRMED', 'CANCELLED'];
const PAYMENT_MODES = ['NEFT', 'RTGS', 'CHEQUE', 'UPI', 'DD'];

// Forward status flow (drives transition buttons in the drawer).
const STATUS_NEXT: Record<string, string[]> = {
  INITIATED: ['AMOUNT_RECEIVED'],
  AMOUNT_RECEIVED: ['AGREEMENT_SENT'],
  AGREEMENT_SENT: ['AGREEMENT_SIGNED'],
  AGREEMENT_SIGNED: ['CONFIRMED'],
  CONFIRMED: [],
  CANCELLED: [],
};

function openHtmlWindow(html: string) {
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
}

export default function Bookings() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [statusFilter, setStatusFilter] = useState('');
  const [showWizard, setShowWizard] = useState(false);

  const list = useQuery({
    queryKey: ['bookings', statusFilter],
    queryFn: async () => {
      const params = statusFilter ? { status: statusFilter } : {};
      return (await api.get('/bookings', { params })).data as { data: any[]; meta: any };
    },
  });

  const columns: Column<any>[] = [
    { key: 'bookingNumber', header: 'Booking #', render: (r) => <span className="font-medium text-slate-900">{r.bookingNumber ?? r.code ?? '—'}</span> },
    { key: 'account', header: 'Account', render: (r) => r.account?.name ?? r.accountName ?? '—' },
    { key: 'unit', header: 'Unit', render: (r) => r.unit?.unitNumber ?? r.unitNumber ?? '—' },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'bookingDate', header: 'Booked', render: (r) => (r.bookingDate ? new Date(r.bookingDate).toLocaleDateString('en-IN') : '—') },
    { key: 'bookingAmountPaise', header: 'Amount', render: (r) => formatPaise(r.bookingAmountPaise) },
    { key: 'agent', header: 'Agent', render: (r) => r.agent?.name ?? r.agentName ?? '—' },
  ];

  return (
    <div>
      <PageHeader
        title="Bookings"
        subtitle="Unit reservations and agreement lifecycle"
        actions={
          <>
            <select className="input w-52" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All statuses</option>
              {BOOKING_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
            </select>
            <button className="btn-primary" onClick={() => setShowWizard(true)}>
              <Plus size={16} /> New Booking
            </button>
          </>
        }
      />

      <DataTable
        columns={columns}
        rows={list.data?.data}
        loading={list.isLoading}
        onRowClick={(r) => navigate(`/bookings/${r.id}`)}
        emptyTitle="No bookings yet"
        emptyHint="Create a booking to reserve a unit for a verified account."
      />

      {showWizard && <BookingWizard onClose={() => setShowWizard(false)} />}
      {id && <BookingDrawer id={id} onClose={() => navigate('/bookings')} />}
    </div>
  );
}

// ─────────────────────────── Multi-step wizard ───────────────────────────

interface WizardState {
  accountId: string;
  projectId: string;
  unitId: string;
  bookingAmountRupees: string;
  paymentMode: string;
  coApplicants: { name: string; relation: string }[];
}

function BookingWizard({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState(1);
  const [error, setError] = useState('');
  const [s, setS] = useState<WizardState>({
    accountId: '', projectId: '', unitId: '', bookingAmountRupees: '', paymentMode: 'NEFT', coApplicants: [],
  });

  const accounts = useQuery({
    queryKey: ['accounts', 'booking-wizard'],
    queryFn: async () => (await api.get('/accounts')).data as { data: any[]; meta: any },
  });

  const projects = useQuery({
    queryKey: ['inventory-projects'],
    queryFn: async () => (await api.get('/inventory/projects')).data as { data: any[]; meta: any },
  });

  const inventory = useQuery({
    queryKey: ['inventory', s.projectId],
    enabled: !!s.projectId,
    queryFn: async () => (await api.get(`/inventory/projects/${s.projectId}/inventory`)).data,
  });

  const createMut = useMutation({
    mutationFn: async () =>
      (await api.post('/bookings', {
        accountId: s.accountId,
        unitId: s.unitId,
        projectId: s.projectId,
        bookingAmountRupees: Number(s.bookingAmountRupees),
        paymentMode: s.paymentMode,
        coApplicants: s.coApplicants.filter((c) => c.name.trim()),
      })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bookings'] });
      onClose();
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const selectedAccount = (accounts.data?.data ?? []).find((a) => a.id === s.accountId);
  const availableUnits: any[] = (inventory.data?.towers ?? [])
    .flatMap((t: any) => (t.units ?? []).map((u: any) => ({ ...u, towerName: t.name })))
    .filter((u: any) => u.status === 'AVAILABLE' || u.status === 'BLOCKED');
  const selectedUnit = availableUnits.find((u) => u.id === s.unitId);

  const canNext =
    (step === 1 && !!s.accountId) ||
    (step === 2 && !!s.unitId) ||
    (step === 3 && !!s.bookingAmountRupees && !!s.paymentMode);

  return (
    <Modal
      open
      onClose={onClose}
      title={`New Booking — Step ${step} of 3`}
      footer={
        <>
          {step > 1 && <button className="btn-ghost" onClick={() => setStep(step - 1)}>Back</button>}
          {step < 3 ? (
            <button className="btn-primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Next</button>
          ) : (
            <button className="btn-primary" disabled={!canNext || createMut.isPending} onClick={() => createMut.mutate()}>
              {createMut.isPending ? 'Booking…' : 'Create Booking'}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {/* Step indicator */}
        <div className="flex items-center gap-2">
          {['Account', 'Unit', 'Details'].map((lbl, i) => {
            const n = i + 1;
            return (
              <div key={lbl} className="flex flex-1 items-center gap-2">
                <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${step >= n ? 'bg-brand-600 text-white' : 'bg-slate-200 text-slate-500'}`}>{n}</span>
                <span className={`text-xs font-medium ${step >= n ? 'text-slate-800' : 'text-slate-400'}`}>{lbl}</span>
                {n < 3 && <span className="h-px flex-1 bg-slate-200" />}
              </div>
            );
          })}
        </div>

        {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}

        {/* Step 1: Account */}
        {step === 1 && (
          <div className="space-y-3">
            {accounts.isLoading ? <Spinner /> : (
              <Field label="Account">
                <select className="input" value={s.accountId} onChange={(e) => setS({ ...s, accountId: e.target.value })}>
                  <option value="">Select account…</option>
                  {(accounts.data?.data ?? []).map((a) => (
                    <option key={a.id} value={a.id}>{a.name} — {a.kycStatus}</option>
                  ))}
                </select>
              </Field>
            )}
            {selectedAccount && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-slate-500">KYC:</span>
                <StatusBadge status={selectedAccount.kycStatus} />
              </div>
            )}
            {selectedAccount && selectedAccount.kycStatus !== 'VERIFIED' && (
              <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
                KYC is not VERIFIED. The booking will be rejected until KYC is verified.
              </div>
            )}
          </div>
        )}

        {/* Step 2: Unit */}
        {step === 2 && (
          <div className="space-y-3">
            <Field label="Project">
              <select className="input" value={s.projectId} onChange={(e) => setS({ ...s, projectId: e.target.value, unitId: '' })}>
                <option value="">Select project…</option>
                {(projects.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            {s.projectId && (inventory.isLoading ? <Spinner /> : (
              availableUnits.length === 0 ? (
                <p className="text-sm text-slate-400">No available units in this project.</p>
              ) : (
                <Field label="Unit (Available / Blocked)">
                  <select className="input" value={s.unitId} onChange={(e) => setS({ ...s, unitId: e.target.value })}>
                    <option value="">Select unit…</option>
                    {availableUnits.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.towerName ? `${u.towerName} · ` : ''}{u.unitNumber ?? u.name} ({u.type ?? u.unitType ?? '—'}) — {u.status}
                      </option>
                    ))}
                  </select>
                </Field>
              )
            ))}
            {selectedUnit && (
              <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
                Selected: <span className="font-medium text-slate-800">{selectedUnit.unitNumber ?? selectedUnit.name}</span> · {selectedUnit.type ?? selectedUnit.unitType ?? ''} · <StatusBadge status={selectedUnit.status} />
              </div>
            )}
          </div>
        )}

        {/* Step 3: Details */}
        {step === 3 && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Booking amount (₹)">
                <input className="input" type="number" min={0} value={s.bookingAmountRupees} onChange={(e) => setS({ ...s, bookingAmountRupees: e.target.value })} />
              </Field>
              <Field label="Payment mode">
                <select className="input" value={s.paymentMode} onChange={(e) => setS({ ...s, paymentMode: e.target.value })}>
                  {PAYMENT_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </Field>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="label !mb-0">Co-applicants</span>
                <button
                  className="btn-ghost !py-1 !text-xs"
                  onClick={() => setS({ ...s, coApplicants: [...s.coApplicants, { name: '', relation: '' }] })}
                >
                  <Plus size={14} /> Add
                </button>
              </div>
              <div className="space-y-2">
                {s.coApplicants.length === 0 && <p className="text-xs text-slate-400">No co-applicants.</p>}
                {s.coApplicants.map((c, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      className="input"
                      placeholder="Name"
                      value={c.name}
                      onChange={(e) => {
                        const next = [...s.coApplicants];
                        next[i] = { ...next[i], name: e.target.value };
                        setS({ ...s, coApplicants: next });
                      }}
                    />
                    <input
                      className="input"
                      placeholder="Relation"
                      value={c.relation}
                      onChange={(e) => {
                        const next = [...s.coApplicants];
                        next[i] = { ...next[i], relation: e.target.value };
                        setS({ ...s, coApplicants: next });
                      }}
                    />
                    <button
                      className="text-slate-400 hover:text-rose-600"
                      onClick={() => setS({ ...s, coApplicants: s.coApplicants.filter((_, j) => j !== i) })}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ─────────────────────────── Detail drawer ───────────────────────────

function BookingDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [showCancel, setShowCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelCharges, setCancelCharges] = useState('');

  const detail = useQuery({
    queryKey: ['booking', id],
    queryFn: async () => (await api.get(`/bookings/${id}`)).data,
  });

  const statusMut = useMutation({
    mutationFn: async (status: string) => (await api.patch(`/bookings/${id}/status`, { status })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['booking', id] });
      queryClient.invalidateQueries({ queryKey: ['bookings'] });
      setError('');
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const cancelMut = useMutation({
    mutationFn: async () =>
      (await api.post(`/bookings/${id}/cancel`, {
        cancellationReason: cancelReason,
        cancellationChargesRupees: cancelCharges ? Number(cancelCharges) : undefined,
      })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['booking', id] });
      queryClient.invalidateQueries({ queryKey: ['bookings'] });
      setShowCancel(false);
      setError('');
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const letterMut = useMutation({
    mutationFn: async () => (await api.get(`/bookings/${id}/allotment-letter`)).data as { html: string },
    onSuccess: (d) => { if (d?.html) openHtmlWindow(d.html); },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const [commission, setCommission] = useState<any>(null);
  const commissionMut = useMutation({
    mutationFn: async () => (await api.get(`/bookings/${id}/commission`)).data,
    onSuccess: (d) => setCommission(d),
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const b = detail.data;
  const transitions = b ? STATUS_NEXT[b.status] ?? [] : [];
  const coApplicants: any[] = b?.coApplicants ?? [];
  const demands: any[] = b?.demands ?? [];
  const receipts: any[] = b?.receipts ?? [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
      <div className="h-full w-full max-w-xl overflow-y-auto bg-surface shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <h3 className="font-semibold text-slate-800">Booking detail</h3>
          <button className="text-slate-400 hover:text-slate-600" onClick={onClose}>✕</button>
        </div>

        {detail.isLoading ? (
          <Spinner />
        ) : !b ? (
          <div className="p-5 text-sm text-slate-500">Not found.</div>
        ) : (
          <div className="space-y-5 p-5">
            {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}

            <div>
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-slate-900">{b.bookingNumber ?? b.code ?? 'Booking'}</h2>
                <StatusBadge status={b.status} />
              </div>
              <p className="mt-1 text-sm text-slate-500">
                {b.account?.name ?? '—'} · Unit {b.unit?.unitNumber ?? '—'} · {formatPaise(b.bookingAmountPaise)}
              </p>
            </div>

            {/* Status transitions */}
            <div className="flex flex-wrap gap-2 rounded-lg bg-slate-50 p-3">
              <span className="self-center text-xs font-medium text-slate-500">Actions:</span>
              {transitions.map((st) => (
                <button key={st} className="btn-primary !py-1.5" disabled={statusMut.isPending} onClick={() => statusMut.mutate(st)}>
                  → {st.replace(/_/g, ' ')}
                </button>
              ))}
              <button className="btn-outline !py-1.5" disabled={letterMut.isPending} onClick={() => letterMut.mutate()}>Allotment Letter</button>
              <button className="btn-outline !py-1.5" disabled={commissionMut.isPending} onClick={() => commissionMut.mutate()}>Commission</button>
              {b.status !== 'CANCELLED' && (
                <button className="btn-outline !py-1.5 !text-rose-600" onClick={() => setShowCancel(true)}>Cancel</button>
              )}
            </div>

            {commission && (
              <Card className="!p-4">
                <h4 className="mb-2 font-semibold text-slate-800">Commission</h4>
                <div className="space-y-1 text-sm">
                  {Object.entries(commission).map(([k, v]) => (
                    <div key={k} className="flex justify-between">
                      <span className="text-slate-500">{k.replace(/Paise$/, '').replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}</span>
                      <span className="font-medium text-slate-800">{/Paise$/.test(k) ? formatPaise(v as any) : String(v)}</span>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Co-applicants */}
            <Section title="Co-applicants">
              {coApplicants.length === 0 ? <Muted>None</Muted> : coApplicants.map((c, i) => (
                <Row key={i} left={c.name} right={c.relation} />
              ))}
            </Section>

            {/* Demands */}
            <Section title="Demands">
              {demands.length === 0 ? <Muted>None</Muted> : demands.map((d, i) => (
                <div key={d.id ?? i} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm">
                  <span className="font-medium text-slate-800">{d.demandNumber ?? d.milestoneLabel ?? 'Demand'}</span>
                  <span className="flex items-center gap-2">
                    {formatPaise(d.totalPaise ?? d.amountPaise)}
                    <StatusBadge status={d.status} />
                  </span>
                </div>
              ))}
            </Section>

            {/* Receipts */}
            <Section title="Receipts">
              {receipts.length === 0 ? <Muted>None</Muted> : receipts.map((r, i) => (
                <div key={r.id ?? i} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm">
                  <span className="font-medium text-slate-800">{r.receiptNumber ?? r.number ?? 'Receipt'}</span>
                  <span>{formatPaise(r.amountPaise)}</span>
                </div>
              ))}
            </Section>
          </div>
        )}
      </div>

      {/* Cancel modal */}
      <div onClick={(e) => e.stopPropagation()}>
        <Modal
          open={showCancel}
          onClose={() => setShowCancel(false)}
          title="Cancel Booking"
          footer={
            <>
              <button className="btn-ghost" onClick={() => setShowCancel(false)}>Back</button>
              <button className="btn-primary !bg-rose-600 hover:!bg-rose-700" disabled={!cancelReason || cancelMut.isPending} onClick={() => cancelMut.mutate()}>
                {cancelMut.isPending ? 'Submitting…' : 'Request Cancellation'}
              </button>
            </>
          }
        >
          <div className="space-y-3">
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">Cancellation requires dual approval before it takes effect.</p>
            <Field label="Cancellation reason">
              <textarea className="input" rows={3} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
            </Field>
            <Field label="Cancellation charges (₹)">
              <input className="input" type="number" min={0} value={cancelCharges} onChange={(e) => setCancelCharges(e.target.value)} />
            </Field>
          </div>
        </Modal>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="text-sm text-slate-400">{children}</p>;
}

function Row({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm">
      <span className="font-medium text-slate-800">{left ?? '—'}</span>
      <span className="text-slate-500">{right ?? '—'}</span>
    </div>
  );
}
