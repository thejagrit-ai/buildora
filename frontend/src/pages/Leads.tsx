import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutGrid, List as ListIcon, Plus, Upload } from 'lucide-react';
import { api, apiErrorMessage } from '../api/client';
import { PageHeader, Card, StatusBadge, Spinner, Field, Modal, EmptyState } from '../components/ui';
import { DataTable, Column } from '../components/DataTable';
import { formatPaise } from '../lib/money';
import { CustomFieldInputs, CustomFieldsPanel, saveCustomFieldValues } from '../components/customFields';

const STAGES = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'SITE_VISIT_SCHEDULED',
  'NEGOTIATION',
  'CONVERTED',
  'LOST',
] as const;

const SOURCE_CHANNELS = [
  'GOOGLE_ADS', 'FACEBOOK', 'INSTAGRAM', 'EMAIL', 'WALK_IN', 'REFERRAL', 'BROKER', 'OTHER',
];
const ACTIVITY_TYPES = ['NOTE', 'CALL', 'EMAIL', 'WHATSAPP'];

interface NewLead {
  name: string;
  mobile: string;
  email: string;
  sourceChannel: string;
  interestType: string;
  bhk: string;
  budgetMinRupees: string;
  budgetMaxRupees: string;
  preferredLocation: string;
  city: string;
  projectId: string;
}

const emptyLead: NewLead = {
  name: '', mobile: '', email: '', sourceChannel: 'OTHER', interestType: '',
  bhk: '', budgetMinRupees: '', budgetMaxRupees: '', preferredLocation: '', city: '', projectId: '',
};

function budgetRange(l: any): string {
  const min = l.budgetMinPaise ? formatPaise(l.budgetMinPaise) : null;
  const max = l.budgetMaxPaise ? formatPaise(l.budgetMaxPaise) : null;
  if (min && max) return `${min} – ${max}`;
  if (min) return `${min}+`;
  if (max) return `up to ${max}`;
  return '—';
}

export default function Leads() {
  const navigate = useNavigate();
  const { id } = useParams();
  const queryClient = useQueryClient();

  const [view, setView] = useState<'kanban' | 'list'>('kanban');
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const list = useQuery({
    queryKey: ['leads'],
    queryFn: async () => (await api.get('/leads', { params: { pageSize: 200 } })).data as { data: any[]; meta: any },
  });

  const leads = list.data?.data ?? [];

  return (
    <div>
      <PageHeader
        title="Leads"
        subtitle="Track and progress every prospect through your pipeline"
        actions={
          <>
            <div className="flex rounded-lg border border-slate-300 bg-surface p-0.5">
              <button
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${view === 'kanban' ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
                onClick={() => setView('kanban')}
              >
                <LayoutGrid size={15} /> Kanban
              </button>
              <button
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${view === 'list' ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
                onClick={() => setView('list')}
              >
                <ListIcon size={15} /> List
              </button>
            </div>
            <button className="btn-outline" onClick={() => setShowImport(true)}>
              <Upload size={16} /> Import
            </button>
            <button className="btn-primary" onClick={() => setShowAdd(true)}>
              <Plus size={16} /> Add Lead
            </button>
          </>
        }
      />

      {list.isLoading ? (
        <Spinner />
      ) : view === 'kanban' ? (
        <KanbanBoard leads={leads} onOpen={(lid) => navigate(`/leads/${lid}`)} />
      ) : (
        <ListView leads={leads} onOpen={(lid) => navigate(`/leads/${lid}`)} />
      )}

      {showAdd && <AddLeadModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); queryClient.invalidateQueries({ queryKey: ['leads'] }); }} />}
      {showImport && <ImportModal onClose={() => setShowImport(false)} onSaved={() => { setShowImport(false); queryClient.invalidateQueries({ queryKey: ['leads'] }); }} />}

      {id && <LeadDrawer id={id} onClose={() => navigate('/leads')} />}
    </div>
  );
}

// ── Kanban ──────────────────────────────────────────────────────────────────

function KanbanBoard({ leads, onOpen }: { leads: any[]; onOpen: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  const [lostFor, setLostFor] = useState<string | null>(null);
  const [lostReason, setLostReason] = useState('');
  const [error, setError] = useState('');

  const stageMut = useMutation({
    mutationFn: async ({ id, stage, reason }: { id: string; stage: string; reason?: string }) =>
      (await api.patch(`/leads/${id}/stage`, { stage, ...(reason ? { lostReason: reason } : {}) })).data,
    // Optimistically move the card so the drop feels instant; roll back on error.
    onMutate: async ({ id, stage }) => {
      setError('');
      await queryClient.cancelQueries({ queryKey: ['leads'] });
      const prev = queryClient.getQueryData<{ data: any[]; meta: any }>(['leads']);
      queryClient.setQueryData<{ data: any[]; meta: any }>(['leads'], (old) =>
        old ? { ...old, data: old.data.map((l) => (l.id === id ? { ...l, stage } : l)) } : old,
      );
      return { prev };
    },
    onError: (e, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['leads'], ctx.prev);
      setError(apiErrorMessage(e));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['leads'] }),
  });

  function handleDrop(stage: string) {
    setOverStage(null);
    const id = dragId;
    setDragId(null);
    if (!id) return;
    const lead = leads.find((l) => l.id === id);
    if (!lead || lead.stage === stage) return;
    if (stage === 'LOST') {
      setLostFor(id);
      setLostReason('');
      return;
    }
    // Conversion creates (or links) an Account and optionally an Opportunity, so
    // route it through the proper convert flow instead of a bare stage change.
    if (stage === 'CONVERTED') {
      onOpen(id);
      return;
    }
    stageMut.mutate({ id, stage });
  }

  return (
    <>
      {error && <div className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}
      <div className="flex gap-3 overflow-x-auto pb-4">
        {STAGES.map((stage) => {
          const items = leads.filter((l) => l.stage === stage);
          const isConvert = stage === 'CONVERTED';
          return (
            <div
              key={stage}
              className={`flex w-72 flex-shrink-0 flex-col rounded-xl border transition-colors ${overStage === stage ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-slate-50'}`}
              onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOverStage(stage); } }}
              onDragLeave={() => setOverStage((s) => (s === stage ? null : s))}
              onDrop={() => handleDrop(stage)}
            >
              <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {stage.replace(/_/g, ' ')}
                </span>
                <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-slate-500">{items.length}</span>
              </div>
              <div className="flex flex-1 flex-col gap-2 p-2">
                {items.length === 0 && (
                  <p className="px-1 py-3 text-center text-xs text-slate-400">
                    {dragId ? (isConvert ? 'Drop to convert…' : 'Drop here') : 'No leads'}
                  </p>
                )}
                {items.map((l) => (
                  <div
                    key={l.id}
                    draggable
                    // setData is REQUIRED for Firefox to initiate a drag at all.
                    onDragStart={(e) => {
                      setDragId(l.id);
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', l.id);
                    }}
                    onDragEnd={() => { setDragId(null); setOverStage(null); }}
                    onClick={() => onOpen(l.id)}
                    className={`rounded-lg border border-slate-200 bg-surface p-3 shadow-sm transition hover:shadow cursor-grab active:cursor-grabbing ${dragId === l.id ? 'opacity-40' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium text-slate-900">{l.name}</span>
                      {l.score != null && (
                        <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">{l.score}</span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">{l.mobile ?? '—'}</div>
                    <div className="mt-1.5 text-xs text-slate-600">{budgetRange(l)}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Lost reason modal */}
      <Modal
        open={!!lostFor}
        onClose={() => setLostFor(null)}
        title="Mark lead as Lost"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setLostFor(null)}>Cancel</button>
            <button
              className="btn-primary"
              disabled={!lostReason.trim() || stageMut.isPending}
              onClick={() => {
                if (lostFor) stageMut.mutate({ id: lostFor, stage: 'LOST', reason: lostReason.trim() });
                setLostFor(null);
              }}
            >
              Mark Lost
            </button>
          </>
        }
      >
        <Field label="Reason (required)">
          <textarea className="input min-h-[90px]" value={lostReason} onChange={(e) => setLostReason(e.target.value)} placeholder="Why was this lead lost?" />
        </Field>
      </Modal>
    </>
  );
}

// ── List ────────────────────────────────────────────────────────────────────

function ListView({ leads, onOpen }: { leads: any[]; onOpen: (id: string) => void }) {
  const columns: Column<any>[] = [
    { key: 'name', header: 'Name', render: (r) => <span className="font-medium text-slate-900">{r.name}</span> },
    { key: 'mobile', header: 'Mobile' },
    { key: 'stage', header: 'Stage', render: (r) => <StatusBadge status={r.stage} /> },
    { key: 'score', header: 'Score', render: (r) => r.score ?? '—' },
    { key: 'source', header: 'Source', render: (r) => String(r.sourceChannel ?? r.source ?? '—').replace(/_/g, ' ') },
    { key: 'owner', header: 'Owner', render: (r) => r.owner?.name ?? r.ownerName ?? '—' },
  ];
  return (
    <DataTable
      columns={columns}
      rows={leads}
      onRowClick={(r) => onOpen(r.id)}
      emptyTitle="No leads yet"
      emptyHint="Add a lead or import a list to get started."
    />
  );
}

// ── Add lead ────────────────────────────────────────────────────────────────

function AddLeadModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<NewLead>(emptyLead);
  const [customValues, setCustomValues] = useState<Record<string, any>>({});
  const [error, setError] = useState('');

  // Project interest feeds the lead-routing engine (Settings → Lead Routing).
  const projects = useQuery({
    queryKey: ['lead-projects'],
    queryFn: async () => ((await api.get('/inventory/projects', { params: { pageSize: 200 } })).data?.data ?? []) as any[],
  });

  const mut = useMutation({
    mutationFn: async () => {
      const created = (await api.post('/leads', {
        name: form.name,
        mobile: form.mobile,
        email: form.email || undefined,
        sourceChannel: form.sourceChannel,
        interestType: form.interestType || undefined,
        bhk: form.bhk || undefined,
        budgetMinRupees: form.budgetMinRupees ? Number(form.budgetMinRupees) : undefined,
        budgetMaxRupees: form.budgetMaxRupees ? Number(form.budgetMaxRupees) : undefined,
        preferredLocation: form.preferredLocation || undefined,
        city: form.city || undefined,
        projectId: form.projectId || undefined,
      })).data;
      await saveCustomFieldValues('LEAD', created.id, customValues);
      return created;
    },
    onSuccess: onSaved,
    onError: (e) => setError(apiErrorMessage(e)),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Add Lead"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!form.name || !form.mobile || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? 'Saving…' : 'Add Lead'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Mobile">
            <input className="input" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} />
          </Field>
        </div>
        <Field label="Email">
          <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Source channel">
            <select className="input" value={form.sourceChannel} onChange={(e) => setForm({ ...form, sourceChannel: e.target.value })}>
              {SOURCE_CHANNELS.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
            </select>
          </Field>
          <Field label="Interest type">
            <input className="input" value={form.interestType} onChange={(e) => setForm({ ...form, interestType: e.target.value })} placeholder="e.g. Apartment" />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="BHK">
            <input className="input" value={form.bhk} onChange={(e) => setForm({ ...form, bhk: e.target.value })} placeholder="e.g. 3" />
          </Field>
          <Field label="Budget min (₹)">
            <input type="number" min="0" className="input" value={form.budgetMinRupees} onChange={(e) => setForm({ ...form, budgetMinRupees: e.target.value })} />
          </Field>
          <Field label="Budget max (₹)">
            <input type="number" min="0" className="input" value={form.budgetMaxRupees} onChange={(e) => setForm({ ...form, budgetMaxRupees: e.target.value })} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Preferred location">
            <input className="input" value={form.preferredLocation} onChange={(e) => setForm({ ...form, preferredLocation: e.target.value })} />
          </Field>
          <Field label="City">
            <input className="input" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="e.g. Bengaluru" />
          </Field>
        </div>
        <Field label="Project interest">
          <select className="input" value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
            <option value="">No specific project</option>
            {(projects.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <CustomFieldInputs objectType="LEAD" values={customValues} onChange={setCustomValues} />
      </div>
    </Modal>
  );
}

// ── Import ──────────────────────────────────────────────────────────────────

function ImportModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  const parsed = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, mobile, email] = line.split(',').map((p) => p?.trim() ?? '');
      return { name, mobile, email };
    })
    .filter((r) => r.name && r.mobile);

  const mut = useMutation({
    mutationFn: async () =>
      (await api.post('/leads/import', {
        leads: parsed.map((r) => ({
          name: r.name,
          mobile: r.mobile,
          ...(r.email ? { email: r.email } : {}),
          sourceChannel: 'OTHER',
        })),
      })).data,
    onSuccess: onSaved,
    onError: (e) => setError(apiErrorMessage(e)),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Import Leads"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={parsed.length === 0 || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? 'Importing…' : `Import ${parsed.length} lead${parsed.length === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}
        <p className="text-sm text-slate-500">Paste one lead per line as <code className="rounded bg-slate-100 px-1">name,mobile,email</code></p>
        <textarea
          className="input min-h-[160px] font-mono text-xs"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'Priya Sharma,9876543210,priya@example.com\nRahul Verma,9123456780'}
        />
        {parsed.length > 0 && <p className="text-xs text-slate-400">{parsed.length} valid row(s) detected.</p>}
      </div>
    </Modal>
  );
}

// ── Lead drawer ───────────────────────────────────────────────────────────────

function LeadDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [activityType, setActivityType] = useState('NOTE');
  const [summary, setSummary] = useState('');
  const [error, setError] = useState('');
  const [showConvert, setShowConvert] = useState(false);
  const [converted, setConverted] = useState(false);

  // Convert form (Salesforce-style: Account first, Opportunity/Project optional).
  const [acctMode, setAcctMode] = useState<'new' | 'existing'>('new');
  const [salutation, setSalutation] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [acctQuery, setAcctQuery] = useState('');
  const [selectedAccount, setSelectedAccount] = useState<{ id: string; name: string } | null>(null);
  const [createOpp, setCreateOpp] = useState(false);
  const [projectId, setProjectId] = useState('');

  const detail = useQuery({
    queryKey: ['lead', id],
    queryFn: async () => (await api.get(`/leads/${id}`)).data,
  });
  const timeline = useQuery({
    queryKey: ['lead-timeline', id],
    queryFn: async () => {
      const res = (await api.get(`/leads/${id}/timeline`)).data;
      return Array.isArray(res) ? res : res?.data ?? [];
    },
  });

  const addActivity = useMutation({
    mutationFn: async () => (await api.post(`/leads/${id}/activities`, { type: activityType, summary })).data,
    onSuccess: () => {
      setSummary('');
      queryClient.invalidateQueries({ queryKey: ['lead-timeline', id] });
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const projects = useQuery({
    queryKey: ['inventory-projects'],
    enabled: showConvert && createOpp,
    queryFn: async () => {
      const res = (await api.get('/inventory/projects')).data;
      return (Array.isArray(res) ? res : res?.data ?? []) as any[];
    },
  });

  // Existing-account search (Choose Existing Account).
  const accountSearch = useQuery({
    queryKey: ['convert-account-search', acctQuery],
    enabled: showConvert && acctMode === 'existing' && acctQuery.trim().length >= 2,
    queryFn: async () =>
      ((await api.get('/accounts', { params: { q: acctQuery.trim(), pageSize: 8 } })).data?.data ?? []) as any[],
  });

  function openConvert() {
    // Prefill the person's name from the lead (e.g. "Kiran Rao" → Kiran / Rao).
    const parts = String(detail.data?.name ?? '').trim().split(/\s+/).filter(Boolean);
    setFirstName(parts.length > 1 ? parts.slice(0, -1).join(' ') : '');
    setLastName(parts.length > 0 ? parts[parts.length - 1] : '');
    setSalutation('');
    setAcctMode('new');
    setSelectedAccount(null);
    setAcctQuery('');
    setCreateOpp(false);
    setProjectId('');
    setError('');
    setShowConvert(true);
  }

  const convertMut = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> =
        acctMode === 'existing'
          ? { accountId: selectedAccount?.id }
          : { salutation: salutation || undefined, firstName: firstName || undefined, lastName };
      if (createOpp && projectId) payload.projectId = projectId;
      return (await api.post(`/leads/${id}/convert`, payload)).data;
    },
    onSuccess: () => {
      setConverted(true);
      setShowConvert(false);
      queryClient.invalidateQueries({ queryKey: ['lead', id] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const convertValid =
    (acctMode === 'existing' ? !!selectedAccount : lastName.trim().length > 0) && (!createOpp || !!projectId);

  const l = detail.data;
  const events = timeline.data ?? [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-y-auto bg-surface shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <h3 className="font-semibold text-slate-800">Lead details</h3>
          <button className="text-slate-400 hover:text-slate-600" onClick={onClose}>✕</button>
        </div>

        {detail.isLoading ? (
          <Spinner />
        ) : !l ? (
          <div className="p-5 text-sm text-slate-500">Not found.</div>
        ) : (
          <div className="space-y-5 p-5">
            {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}
            {converted && <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">Lead converted successfully.</div>}

            <div>
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-slate-900">{l.name}</h2>
                <StatusBadge status={l.stage} />
              </div>
              <p className="mt-1 text-sm text-slate-500">{l.mobile ?? '—'}{l.email ? ` · ${l.email}` : ''}</p>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="label">Score</div>
                <div className="font-medium text-slate-800">{l.score ?? '—'}</div>
              </div>
              <div>
                <div className="label">Source</div>
                <div className="text-slate-700">{String(l.sourceChannel ?? '—').replace(/_/g, ' ')}</div>
              </div>
              <div>
                <div className="label">Budget</div>
                <div className="text-slate-700">{budgetRange(l)}</div>
              </div>
              <div>
                <div className="label">Location</div>
                <div className="text-slate-700">{l.preferredLocation ?? '—'}</div>
              </div>
            </div>

            <button className="btn-primary w-full justify-center" onClick={openConvert}>
              Convert lead
            </button>

            <CustomFieldsPanel objectType="LEAD" recordId={id} />

            {/* Add activity */}
            <Card className="!p-4">
              <h4 className="mb-2 font-semibold text-slate-800">Log activity</h4>
              <div className="space-y-2">
                <select className="input" value={activityType} onChange={(e) => setActivityType(e.target.value)}>
                  {ACTIVITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <textarea className="input min-h-[70px]" placeholder="Summary…" value={summary} onChange={(e) => setSummary(e.target.value)} />
                <button className="btn-outline w-full justify-center" disabled={!summary.trim() || addActivity.isPending} onClick={() => addActivity.mutate()}>
                  {addActivity.isPending ? 'Saving…' : 'Add activity'}
                </button>
              </div>
            </Card>

            {/* Timeline */}
            <div>
              <h4 className="mb-2 font-semibold text-slate-800">Timeline</h4>
              {timeline.isLoading ? (
                <Spinner />
              ) : events.length === 0 ? (
                <EmptyState title="No activity yet" hint="Logged activities will appear here." />
              ) : (
                <ol className="space-y-3 border-l-2 border-slate-100 pl-4">
                  {events.map((ev: any, i: number) => (
                    <li key={ev.id ?? i} className="relative">
                      <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full bg-brand-500" />
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-slate-800">{String(ev.type ?? 'EVENT').replace(/_/g, ' ')}</span>
                        <span className="text-xs text-slate-400">
                          {ev.createdAt ? new Date(ev.createdAt).toLocaleString() : ''}
                        </span>
                      </div>
                      {(ev.summary || ev.description) && <p className="mt-0.5 text-sm text-slate-600">{ev.summary ?? ev.description}</p>}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Convert modal — Account-centric (Project optional) */}
      <Modal
        open={showConvert}
        onClose={() => setShowConvert(false)}
        title="Convert Lead"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setShowConvert(false)}>Cancel</button>
            <button className="btn-primary" disabled={!convertValid || convertMut.isPending} onClick={() => convertMut.mutate()}>
              {convertMut.isPending ? 'Converting…' : 'Convert'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          {/* Account section */}
          <div>
            <div className="mb-2 flex items-center gap-4 text-sm font-medium">
              <label className="flex cursor-pointer items-center gap-1.5">
                <input type="radio" className="accent-brand-600" checked={acctMode === 'new'} onChange={() => setAcctMode('new')} />
                Create New Account
              </label>
              <span className="text-slate-400">— OR —</span>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input type="radio" className="accent-brand-600" checked={acctMode === 'existing'} onChange={() => setAcctMode('existing')} />
                Choose Existing Account
              </label>
            </div>

            {acctMode === 'new' ? (
              <div className="space-y-3 rounded-lg border border-slate-200 p-3">
                <Field label="Salutation">
                  <select className="input" value={salutation} onChange={(e) => setSalutation(e.target.value)}>
                    <option value="">--None--</option>
                    {['Mr.', 'Ms.', 'Mrs.', 'Dr.', 'Prof.'].map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </Field>
                <Field label="First Name">
                  <input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
                </Field>
                <Field label="Last Name *">
                  <input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} />
                </Field>
                <div className="text-xs text-slate-400">A new person account and primary contact will be created.</div>
              </div>
            ) : (
              <div className="space-y-2 rounded-lg border border-slate-200 p-3">
                <Field label="Account Search">
                  <input className="input" value={acctQuery} onChange={(e) => { setAcctQuery(e.target.value); setSelectedAccount(null); }} placeholder="Search by name or PAN…" />
                </Field>
                {acctQuery.trim().length >= 2 && (
                  accountSearch.isLoading ? (
                    <Spinner />
                  ) : (accountSearch.data ?? []).length === 0 ? (
                    <p className="text-sm text-slate-400">No matching accounts.</p>
                  ) : (
                    <ul className="max-h-44 overflow-y-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
                      {(accountSearch.data ?? []).map((a: any) => (
                        <li key={a.id}>
                          <button
                            type="button"
                            onClick={() => setSelectedAccount({ id: a.id, name: a.name })}
                            className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50 ${selectedAccount?.id === a.id ? 'bg-brand-50' : ''}`}
                          >
                            <span className="text-slate-700">{a.name}</span>
                            <span className="text-xs text-slate-400">{String(a.type ?? '').replace(/_/g, ' ')}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )
                )}
                {selectedAccount && (
                  <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">Selected: {selectedAccount.name}</div>
                )}
              </div>
            )}
          </div>

          {/* Optional opportunity — Project is NOT required to convert */}
          <div className="rounded-lg border border-slate-200 p-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
              <input type="checkbox" className="accent-brand-600" checked={createOpp} onChange={(e) => setCreateOpp(e.target.checked)} />
              Also create an opportunity for a project
            </label>
            {createOpp && (
              <div className="mt-3">
                <Field label="Project">
                  {projects.isLoading ? (
                    <Spinner />
                  ) : (
                    <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                      <option value="">Select a project…</option>
                      {(projects.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  )}
                </Field>
                <p className="mt-1 text-xs text-slate-400">Leave unchecked to convert to an account only.</p>
              </div>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
