import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { Plus, Zap, Star } from 'lucide-react';
import { api, apiErrorMessage } from '../api/client';
import { PageHeader, Card, StatusBadge, EmptyState, Spinner, Field, Modal } from '../components/ui';
import { DataTable, Column } from '../components/DataTable';
import { useAuth } from '../store/auth';
import { CustomFieldInputs, saveCustomFieldValues } from '../components/customFields';

const STATUS_OPTIONS = ['SCHEDULED', 'CONFIRMED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'];

function projectName(v: any): string {
  return v.project?.name ?? v.projectName ?? '—';
}
function agentName(v: any): string {
  return v.agent?.name ?? v.agentName ?? '—';
}

export default function SiteVisits() {
  const qc = useQueryClient();
  const can = useAuth((s) => s.can);
  const [alert, setAlert] = useState<string | null>(null);
  const [filters, setFilters] = useState({ status: '', from: '', to: '' });
  const [showSchedule, setShowSchedule] = useState(false);
  const [feedbackFor, setFeedbackFor] = useState<any | null>(null);

  const listQ = useQuery({
    queryKey: ['site-visits', filters],
    queryFn: async () =>
      (await api.get('/site-visits', {
        params: {
          limit: 100,
          ...(filters.status ? { status: filters.status } : {}),
          ...(filters.from ? { from: filters.from } : {}),
          ...(filters.to ? { to: filters.to } : {}),
        },
      })).data,
  });
  const calendarQ = useQuery({
    queryKey: ['site-visits', 'calendar'],
    queryFn: async () => (await api.get('/site-visits/calendar')).data,
  });

  const visits: any[] = listQ.data?.data ?? [];
  const calendar: any[] = Array.isArray(calendarQ.data) ? calendarQ.data : [];

  const statusMut = useMutation({
    mutationFn: async (vars: { id: string; status: string }) =>
      (await api.patch(`/site-visits/${vars.id}/status`, { status: vars.status })).data,
    onSuccess: () => {
      setAlert(null);
      qc.invalidateQueries({ queryKey: ['site-visits'] });
    },
    onError: (err) => setAlert(apiErrorMessage(err)),
  });

  const walkInMut = useMutation({
    mutationFn: async () => (await api.post('/site-visits/walk-in', {})).data,
    onSuccess: () => {
      setAlert(null);
      qc.invalidateQueries({ queryKey: ['site-visits'] });
    },
    onError: (err) => setAlert(apiErrorMessage(err)),
  });

  function act(v: any, status: string) {
    if (status === 'COMPLETED') {
      // Completing requires feedback — open feedback modal first.
      setFeedbackFor(v);
      return;
    }
    statusMut.mutate({ id: v.id, status });
  }

  const columns: Column<any>[] = [
    {
      key: 'scheduledAt',
      header: 'Scheduled',
      render: (v) => (v.scheduledAt ? dayjs(v.scheduledAt).format('DD MMM YYYY, h:mm A') : '—'),
    },
    { key: 'project', header: 'Project', render: projectName },
    { key: 'agent', header: 'Agent', render: agentName },
    { key: 'status', header: 'Status', render: (v) => <StatusBadge status={v.status} /> },
    {
      key: 'isWalkIn',
      header: 'Walk-in',
      render: (v) =>
        v.isWalkIn ? <span className="text-xs font-medium text-amber-600">Walk-in</span> : <span className="text-slate-300">—</span>,
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (v) => {
        if (!can('siteVisits.create')) return null;
        const s = v.status;
        return (
          <div className="flex justify-end gap-1">
            {s === 'SCHEDULED' && (
              <button className="btn-outline px-2 py-1 text-xs" onClick={() => act(v, 'CONFIRMED')}>Confirm</button>
            )}
            {(s === 'SCHEDULED' || s === 'CONFIRMED') && (
              <>
                <button className="btn-outline px-2 py-1 text-xs" onClick={() => act(v, 'COMPLETED')}>Complete</button>
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => act(v, 'NO_SHOW')}>No-show</button>
                <button className="btn-ghost px-2 py-1 text-xs text-rose-600" onClick={() => act(v, 'CANCELLED')}>Cancel</button>
              </>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="Site Visits"
        subtitle="Schedule, track and capture visit feedback"
        actions={
          can('siteVisits.create') && (
            <div className="flex items-center gap-2">
              <button className="btn-outline flex items-center gap-1.5" disabled={walkInMut.isPending} onClick={() => walkInMut.mutate()}>
                <Zap className="h-4 w-4" /> Walk-in
              </button>
              <button className="btn-primary flex items-center gap-1.5" onClick={() => setShowSchedule(true)}>
                <Plus className="h-4 w-4" /> Schedule Visit
              </button>
            </div>
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
            <select className="input" value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
              <option value="">All</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </Field>
          <Field label="From">
            <input className="input" type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
          </Field>
          <Field label="To">
            <input className="input" type="date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
          </Field>
          {(filters.status || filters.from || filters.to) && (
            <button className="btn-ghost" onClick={() => setFilters({ status: '', from: '', to: '' })}>Clear</button>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <DataTable
            columns={columns}
            rows={visits}
            loading={listQ.isLoading}
            emptyTitle="No site visits"
            emptyHint="Schedule a visit or log a walk-in to get started."
          />
        </div>

        <Card>
          <h3 className="mb-4 font-semibold text-slate-800">This week’s agenda</h3>
          {calendarQ.isLoading ? (
            <Spinner />
          ) : calendar.length === 0 ? (
            <p className="text-sm text-slate-400">No upcoming visits.</p>
          ) : (
            <div className="space-y-4">
              {calendar.map((day) => (
                <div key={day.date}>
                  <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    {dayjs(day.date).format('ddd, DD MMM')}
                  </div>
                  <div className="space-y-1.5">
                    {(day.visits ?? []).map((v: any) => (
                      <div key={v.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-slate-700">{projectName(v)}</div>
                          <div className="text-xs text-slate-400">
                            {v.scheduledAt ? dayjs(v.scheduledAt).format('h:mm A') : ''} · {agentName(v)}
                          </div>
                        </div>
                        <StatusBadge status={v.status} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {showSchedule && <ScheduleModal onClose={() => setShowSchedule(false)} onError={setAlert} />}
      {feedbackFor && (
        <FeedbackModal
          visit={feedbackFor}
          onClose={() => setFeedbackFor(null)}
          onError={setAlert}
          onComplete={(id) => {
            setFeedbackFor(null);
            statusMut.mutate({ id, status: 'COMPLETED' });
          }}
        />
      )}
    </div>
  );
}

function ScheduleModal({ onClose, onError }: { onClose: () => void; onError: (m: string) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    leadId: '',
    projectId: '',
    scheduledAt: '',
    transport: 'self' as 'cab' | 'self',
    agentId: '',
  });
  const [customValues, setCustomValues] = useState<Record<string, any>>({});
  const [err, setErr] = useState<string | null>(null);

  const projectsQ = useQuery({
    queryKey: ['inventory', 'projects'],
    queryFn: async () => (await api.get('/inventory/projects')).data,
  });
  const projects: any[] = projectsQ.data?.data ?? projectsQ.data ?? [];

  const createMut = useMutation({
    mutationFn: async () => {
      const body: any = {
        projectId: form.projectId,
        scheduledAt: new Date(form.scheduledAt).toISOString(),
        transport: form.transport,
      };
      if (form.leadId.trim()) body.leadId = form.leadId.trim();
      if (form.agentId.trim()) body.agentId = form.agentId.trim();
      const created = (await api.post('/site-visits', body)).data;
      await saveCustomFieldValues('SITE_VISIT', created.id, customValues);
      return created;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['site-visits'] });
      onClose();
    },
    onError: (e) => onError(apiErrorMessage(e)),
  });

  function submit() {
    setErr(null);
    if (!form.projectId) return setErr('Project is required.');
    if (!form.scheduledAt) return setErr('Scheduled time is required.');
    if (dayjs(form.scheduledAt).isBefore(dayjs())) return setErr('Scheduled time must be in the future.');
    createMut.mutate();
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<any>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Modal
      open
      onClose={onClose}
      title="Schedule Visit"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={createMut.isPending} onClick={submit}>
            {createMut.isPending ? 'Scheduling…' : 'Schedule'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
        <Field label="Lead ID (optional)">
          <input className="input" value={form.leadId} onChange={set('leadId')} placeholder="Lead reference" />
        </Field>
        <Field label="Project">
          <select className="input" value={form.projectId} onChange={set('projectId')}>
            <option value="">Select project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Scheduled at">
          <input className="input" type="datetime-local" value={form.scheduledAt} onChange={set('scheduledAt')} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Transport">
            <select className="input" value={form.transport} onChange={set('transport')}>
              <option value="self">Self</option>
              <option value="cab">Cab</option>
            </select>
          </Field>
          <Field label="Agent ID (optional)">
            <input className="input" value={form.agentId} onChange={set('agentId')} placeholder="Agent reference" />
          </Field>
        </div>
        <CustomFieldInputs objectType="SITE_VISIT" values={customValues} onChange={setCustomValues} />
      </div>
    </Modal>
  );
}

function FeedbackModal({
  visit,
  onClose,
  onError,
  onComplete,
}: {
  visit: any;
  onClose: () => void;
  onError: (m: string) => void;
  onComplete: (id: string) => void;
}) {
  const [form, setForm] = useState({
    rating: 0,
    interestedUnits: '',
    budgetConfirmed: false,
    nextAction: '',
    remarks: '',
  });

  const feedbackMut = useMutation({
    mutationFn: async () => {
      const body: any = {
        rating: form.rating,
        budgetConfirmed: form.budgetConfirmed,
      };
      if (form.interestedUnits.trim()) body.interestedUnits = form.interestedUnits.trim();
      if (form.nextAction.trim()) body.nextAction = form.nextAction.trim();
      if (form.remarks.trim()) body.remarks = form.remarks.trim();
      return (await api.post(`/site-visits/${visit.id}/feedback`, body)).data;
    },
    onSuccess: () => onComplete(visit.id),
    onError: (e) => onError(apiErrorMessage(e)),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Visit Feedback"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={form.rating === 0 || feedbackMut.isPending} onClick={() => feedbackMut.mutate()}>
            {feedbackMut.isPending ? 'Saving…' : 'Save & Complete'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Rating">
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setForm((f) => ({ ...f, rating: n }))}
                className="p-1"
                aria-label={`${n} star`}
              >
                <Star className={`h-6 w-6 ${n <= form.rating ? 'fill-amber-400 text-amber-400' : 'text-slate-300'}`} />
              </button>
            ))}
          </div>
        </Field>
        <Field label="Interested units">
          <input className="input" value={form.interestedUnits} onChange={(e) => setForm((f) => ({ ...f, interestedUnits: e.target.value }))} placeholder="e.g. A-1203, B-0801" />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={form.budgetConfirmed} onChange={(e) => setForm((f) => ({ ...f, budgetConfirmed: e.target.checked }))} />
          Budget confirmed
        </label>
        <Field label="Next action">
          <input className="input" value={form.nextAction} onChange={(e) => setForm((f) => ({ ...f, nextAction: e.target.value }))} placeholder="e.g. Send quotation" />
        </Field>
        <Field label="Remarks">
          <textarea className="input" rows={3} value={form.remarks} onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))} />
        </Field>
      </div>
    </Modal>
  );
}
