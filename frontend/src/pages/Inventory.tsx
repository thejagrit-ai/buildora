import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, apiErrorMessage } from '../api/client';
import { PageHeader, Card, StatCard, StatusBadge, Spinner, Field, Modal, EmptyState } from '../components/ui';
import { formatPaise } from '../lib/money';
import { useAuth } from '../store/auth';

const PROJECT_TYPES = ['RESIDENTIAL', 'COMMERCIAL', 'MIXED_USE', 'PLOTTED'];

const UNIT_STATUSES = ['AVAILABLE', 'BLOCKED', 'BOOKED', 'REGISTERED', 'CANCELLED'];

// Cell color map (matrix grid). Mirrors StatusBadge vocabulary but for filled cells.
const CELL_COLORS: Record<string, string> = {
  AVAILABLE: 'bg-emerald-100 border-emerald-300 hover:bg-emerald-200',
  BLOCKED: 'bg-amber-100 border-amber-300 hover:bg-amber-200',
  BOOKED: 'bg-orange-100 border-orange-300 hover:bg-orange-200',
  REGISTERED: 'bg-blue-100 border-blue-300 hover:bg-blue-200',
  CANCELLED: 'bg-rose-100 border-rose-300 hover:bg-rose-200',
};

const LEGEND: { status: string; label: string }[] = [
  { status: 'AVAILABLE', label: 'Available' },
  { status: 'BLOCKED', label: 'Blocked' },
  { status: 'BOOKED', label: 'Booked' },
  { status: 'REGISTERED', label: 'Registered' },
  { status: 'CANCELLED', label: 'Cancelled' },
];

interface NewProject {
  name: string;
  type: string;
  location: string;
  reraNumber: string;
  launchDate: string;
  possessionDate: string;
  amenities: string;
}

const emptyProject: NewProject = {
  name: '', type: 'RESIDENTIAL', location: '', reraNumber: '',
  launchDate: '', possessionDate: '', amenities: '',
};

export default function Inventory() {
  const queryClient = useQueryClient();
  const canCreate = useAuth((s) => s.can)('inventory.create');

  const [projectId, setProjectId] = useState<string>('');
  const [activeUnitId, setActiveUnitId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<NewProject>(emptyProject);
  const [error, setError] = useState('');

  const projects = useQuery({
    queryKey: ['inventory-projects'],
    queryFn: async () => (await api.get('/inventory/projects')).data as { data: any[]; meta: any },
  });

  // Auto-select first project once loaded.
  useEffect(() => {
    if (!projectId && projects.data?.data?.length) {
      setProjectId(projects.data.data[0].id);
    }
  }, [projects.data, projectId]);

  const inventory = useQuery({
    queryKey: ['inventory', projectId],
    enabled: !!projectId,
    queryFn: async () => (await api.get(`/inventory/projects/${projectId}/inventory`)).data,
  });

  const createMut = useMutation({
    mutationFn: async (body: NewProject) =>
      (await api.post('/inventory/projects', {
        name: body.name,
        type: body.type,
        location: body.location || undefined,
        reraNumber: body.reraNumber || undefined,
        launchDate: body.launchDate || undefined,
        possessionDate: body.possessionDate || undefined,
        amenities: body.amenities
          ? body.amenities.split(',').map((a) => a.trim()).filter(Boolean)
          : undefined,
      })).data,
    onSuccess: (created: any) => {
      queryClient.invalidateQueries({ queryKey: ['inventory-projects'] });
      setShowCreate(false);
      setForm(emptyProject);
      setError('');
      if (created?.id) setProjectId(created.id);
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const summary = inventory.data?.summary ?? {};
  const towers: any[] = inventory.data?.towers ?? [];

  return (
    <div>
      <PageHeader
        title="Inventory"
        subtitle="Project towers, units and real-time availability"
        actions={
          <>
            <select
              className="input w-56"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">Select project…</option>
              {(projects.data?.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {canCreate && (
              <button
                className="btn-primary"
                onClick={() => { setForm(emptyProject); setError(''); setShowCreate(true); }}
              >
                <Plus size={16} /> New Project
              </button>
            )}
          </>
        }
      />

      {projects.isLoading ? (
        <Spinner />
      ) : !projectId ? (
        <EmptyState title="Select a project" hint="Choose a project to view its inventory grid." />
      ) : inventory.isLoading ? (
        <Spinner />
      ) : (
        <div className="space-y-6">
          {/* Summary */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <StatCard label="Available" value={summary.available ?? 0} />
            <StatCard label="Blocked" value={summary.blocked ?? 0} />
            <StatCard label="Booked" value={summary.booked ?? 0} />
            <StatCard label="Registered" value={summary.registered ?? 0} />
            <StatCard label="Total" value={summary.total ?? 0} />
          </div>

          {/* Legend */}
          <div className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-200 bg-surface px-4 py-3 text-xs text-slate-600">
            <span className="font-semibold uppercase tracking-wide text-slate-500">Legend</span>
            {LEGEND.map((l) => (
              <span key={l.status} className="flex items-center gap-1.5">
                <span className={`inline-block h-3.5 w-3.5 rounded border ${CELL_COLORS[l.status].split(' hover')[0]}`} />
                {l.label}
              </span>
            ))}
          </div>

          {/* Towers + grids */}
          {towers.length === 0 ? (
            <EmptyState title="No towers" hint="This project has no towers configured yet." />
          ) : (
            towers.map((tower) => (
              <TowerGrid key={tower.id} tower={tower} onSelect={setActiveUnitId} />
            ))
          )}
        </div>
      )}

      {/* New project modal */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="New Project"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
            <button
              className="btn-primary"
              disabled={!form.name || createMut.isPending}
              onClick={() => createMut.mutate(form)}
            >
              {createMut.isPending ? 'Saving…' : 'Create'}
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
            <Field label="Type">
              <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {PROJECT_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Location">
            <input className="input" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
          </Field>
          <Field label="RERA Number">
            <input className="input" value={form.reraNumber} onChange={(e) => setForm({ ...form, reraNumber: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Launch date">
              <input className="input" type="date" value={form.launchDate} onChange={(e) => setForm({ ...form, launchDate: e.target.value })} />
            </Field>
            <Field label="Possession date">
              <input className="input" type="date" value={form.possessionDate} onChange={(e) => setForm({ ...form, possessionDate: e.target.value })} />
            </Field>
          </div>
          <Field label="Amenities (comma-separated)">
            <input className="input" value={form.amenities} placeholder="Pool, Gym, Clubhouse" onChange={(e) => setForm({ ...form, amenities: e.target.value })} />
          </Field>
        </div>
      </Modal>

      {activeUnitId && <UnitDetailModal unitId={activeUnitId} projectId={projectId} onClose={() => setActiveUnitId(null)} />}
    </div>
  );
}

function TowerGrid({ tower, onSelect }: { tower: any; onSelect: (id: string) => void }) {
  const units: any[] = tower.units ?? [];
  // Group units by floor → rows of cells.
  const byFloor = new Map<string | number, any[]>();
  for (const u of units) {
    const floor = u.floor ?? u.floorNumber ?? 0;
    if (!byFloor.has(floor)) byFloor.set(floor, []);
    byFloor.get(floor)!.push(u);
  }
  const floors = [...byFloor.keys()].sort((a, b) => Number(b) - Number(a)); // top floor first

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-semibold text-slate-800">{tower.name ?? 'Tower'}</h3>
        <span className="text-xs text-slate-400">{units.length} units</span>
      </div>
      {floors.length === 0 ? (
        <p className="text-sm text-slate-400">No units in this tower.</p>
      ) : (
        <div className="space-y-2 overflow-x-auto">
          {floors.map((floor) => (
            <div key={String(floor)} className="flex items-center gap-2">
              <span className="w-10 shrink-0 text-right text-xs font-medium text-slate-400">
                {floor === 0 ? 'G' : floor}
              </span>
              <div className="flex flex-wrap gap-2">
                {byFloor.get(floor)!.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => onSelect(u.id)}
                    title={`${u.unitNumber ?? u.name} · ${u.status}`}
                    className={`flex h-14 w-16 flex-col items-center justify-center rounded-md border text-center transition ${CELL_COLORS[u.status] ?? 'bg-slate-100 border-slate-300 hover:bg-slate-200'}`}
                  >
                    <span className="text-xs font-semibold text-slate-800">{u.unitNumber ?? u.name}</span>
                    <span className="text-[10px] text-slate-500">{u.type ?? u.unitType ?? ''}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const diff = new Date(expiresAt).getTime() - now;
  if (diff <= 0) return <span className="font-medium text-rose-600">Hold expired</span>;
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1000);
  return (
    <span className="font-medium text-amber-700">
      {h}h {m}m {s}s remaining
    </span>
  );
}

function UnitDetailModal({ unitId, projectId, onClose }: { unitId: string; projectId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [holdHours, setHoldHours] = useState(48);
  const [holdReason, setHoldReason] = useState('');
  const [statusTo, setStatusTo] = useState('');

  const detail = useQuery({
    queryKey: ['unit', unitId],
    queryFn: async () => (await api.get(`/inventory/units/${unitId}`)).data,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['unit', unitId] });
    queryClient.invalidateQueries({ queryKey: ['inventory', projectId] });
  };

  const holdMut = useMutation({
    mutationFn: async () =>
      (await api.post(`/inventory/units/${unitId}/hold`, { hours: holdHours, reason: holdReason || undefined })).data,
    onSuccess: () => { invalidate(); setError(''); },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const releaseMut = useMutation({
    mutationFn: async () => (await api.delete(`/inventory/units/${unitId}/hold`)).data,
    onSuccess: () => { invalidate(); setError(''); },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const statusMut = useMutation({
    mutationFn: async (status: string) =>
      (await api.patch(`/inventory/units/${unitId}/status`, { status })).data,
    onSuccess: () => { invalidate(); setError(''); setStatusTo(''); },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const u = detail.data;
  const priceComponents: any[] = u?.priceComponents ?? [];

  return (
    <Modal
      open
      onClose={onClose}
      title={u ? `Unit ${u.unitNumber ?? u.name ?? ''}` : 'Unit'}
      footer={<button className="btn-ghost" onClick={onClose}>Close</button>}
    >
      {detail.isLoading ? (
        <Spinner />
      ) : !u ? (
        <div className="text-sm text-slate-500">Not found.</div>
      ) : (
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}

          <div className="flex items-center justify-between">
            <StatusBadge status={u.status} />
            <span className="text-sm text-slate-500">{u.type ?? u.unitType ?? '—'}</span>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="label">Area</div>
              <div className="font-medium text-slate-800">{u.area ?? u.saleableArea ?? '—'}{u.areaUnit ? ` ${u.areaUnit}` : ' sq.ft'}</div>
            </div>
            <div>
              <div className="label">Facing</div>
              <div className="font-medium text-slate-800">{u.facing ?? '—'}</div>
            </div>
          </div>

          {u.status === 'BLOCKED' && u.holdExpiresAt && (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm">
              <Countdown expiresAt={u.holdExpiresAt} />
            </div>
          )}

          {/* Price components */}
          {priceComponents.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Price components</p>
              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {priceComponents.map((c, i) => (
                  <div key={c.id ?? i} className="flex justify-between px-3 py-2 text-sm">
                    <span className="text-slate-600">{c.label ?? c.name ?? c.type}</span>
                    <span className="font-medium text-slate-800">{formatPaise(c.amountPaise ?? c.valuePaise)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {u.priceSummary && (
            <div className="space-y-1 rounded-lg bg-slate-50 p-3 text-sm">
              {Object.entries(u.priceSummary).map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-slate-500">{k.replace(/Paise$/, '').replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase())}</span>
                  <span className="font-medium text-slate-800">
                    {/Paise$/.test(k) ? formatPaise(v as any) : String(v)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="space-y-3 border-t pt-3">
            {u.status === 'AVAILABLE' && (
              <div className="space-y-2 rounded-lg bg-slate-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Place hold</p>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Hours">
                    <input className="input" type="number" min={1} value={holdHours} onChange={(e) => setHoldHours(Number(e.target.value))} />
                  </Field>
                  <Field label="Reason">
                    <input className="input" value={holdReason} onChange={(e) => setHoldReason(e.target.value)} />
                  </Field>
                </div>
                <button className="btn-primary" disabled={holdMut.isPending} onClick={() => holdMut.mutate()}>
                  {holdMut.isPending ? 'Holding…' : 'Hold'}
                </button>
              </div>
            )}

            {u.status === 'BLOCKED' && (
              <button className="btn-outline" disabled={releaseMut.isPending} onClick={() => releaseMut.mutate()}>
                {releaseMut.isPending ? 'Releasing…' : 'Release Hold'}
              </button>
            )}

            <div className="flex items-end gap-2">
              <Field label="Change status">
                <select className="input w-44" value={statusTo} onChange={(e) => setStatusTo(e.target.value)}>
                  <option value="">Select status…</option>
                  {UNIT_STATUSES.filter((s) => s !== u.status).map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </Field>
              <button
                className="btn-outline"
                disabled={!statusTo || statusMut.isPending}
                onClick={() => statusMut.mutate(statusTo)}
              >
                {statusMut.isPending ? 'Updating…' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
