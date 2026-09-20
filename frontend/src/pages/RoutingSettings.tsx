import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Trash2, Pencil, ArrowUp, ArrowDown, GripVertical, FlaskConical, ArrowRight, Users, User as UserIcon,
} from 'lucide-react';
import { api, apiErrorMessage } from '../api/client';
import { Card, StatusBadge, Spinner, EmptyState, Field, Modal } from '../components/ui';

// ── Shared vocab ──────────────────────────────────────────────────────────────

const CHANNELS = [
  'GOOGLE_ADS', 'FACEBOOK', 'INSTAGRAM', 'EMAIL', 'WALK_IN', 'REFERRAL', 'BROKER', 'OTHER',
] as const;
type Strategy = 'SPECIFIC_USER' | 'ROUND_ROBIN';

interface NamedUser { id: string; name: string; isActive?: boolean }
interface RoutingRule {
  id: string;
  name: string;
  description?: string | null;
  priority: number;
  active: boolean;
  projectId?: string | null;
  campaignId?: string | null;
  sourceChannel?: string | null;
  locations: string[];
  strategy: Strategy;
  targetUserId?: string | null;
  memberIds: string[];
  projectName?: string | null;
  campaignName?: string | null;
  targetUser?: NamedUser | null;
  members: NamedUser[];
}

// Lookup lists used by the rule builder + test panel.
function useLookups() {
  const projects = useQuery({
    queryKey: ['routing-projects'],
    queryFn: async () => ((await api.get('/inventory/projects', { params: { pageSize: 200 } })).data?.data ?? []) as any[],
  });
  const campaigns = useQuery({
    queryKey: ['routing-campaigns'],
    queryFn: async () => ((await api.get('/campaigns', { params: { pageSize: 200 } })).data?.data ?? []) as any[],
  });
  const users = useQuery({
    queryKey: ['routing-users'],
    queryFn: async () => {
      const res = (await api.get('/admin/users')).data;
      const list = (Array.isArray(res) ? res : res?.data ?? []) as any[];
      return list.filter((u) => u.isActive !== false);
    },
  });
  return { projects, campaigns, users };
}

// ── Tab ───────────────────────────────────────────────────────────────────────

export default function RoutingTab() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<RoutingRule | null | undefined>(undefined); // undefined=closed, null=new
  const [showTest, setShowTest] = useState(false);
  const lookups = useLookups();

  const rules = useQuery({
    queryKey: ['routing-rules'],
    queryFn: async () => ((await api.get('/routing/rules')).data?.data ?? []) as RoutingRule[],
  });

  // Local order for instant reorder feedback.
  const [items, setItems] = useState<RoutingRule[]>([]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  useEffect(() => { setItems(rules.data ?? []); }, [rules.data]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['routing-rules'] });

  const del = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/routing/rules/${id}`)).data,
    onSuccess: invalidate,
  });
  const reorder = useMutation({
    mutationFn: async (ordered: RoutingRule[]) => (await api.put('/routing/rules/reorder', { ids: ordered.map((r) => r.id) })).data,
    onError: invalidate,
  });

  function move(from: number, to: number) {
    if (to < 0 || to >= items.length || from === to) return;
    const next = [...items];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    setItems(next);
    reorder.mutate(next);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-slate-500">
          Incoming leads are matched against these rules top-to-bottom; the <strong>first</strong> rule whose conditions all
          match assigns the lead. Route by the project a lead is interested in, where they're located, or the campaign /
          channel they came from — to one salesperson or balanced across a team. Drag to reorder.
        </p>
        <div className="flex items-center gap-2">
          <button className="btn-outline" onClick={() => setShowTest(true)}>
            <FlaskConical size={16} /> Test routing
          </button>
          <button className="btn-primary" onClick={() => setEditing(null)}>
            <Plus size={16} /> New Rule
          </button>
        </div>
      </div>

      {rules.isLoading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No routing rules yet"
          hint='Click "New Rule" to send leads to the right salesperson by project, geography or campaign.'
        />
      ) : (
        <div className="space-y-2">
          {items.map((r, i) => (
            <div
              key={r.id}
              draggable
              onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(e) => { if (dragIdx !== null) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
              onDrop={() => { if (dragIdx !== null) { move(dragIdx, i); setDragIdx(null); } }}
              onDragEnd={() => setDragIdx(null)}
              className={`flex items-start gap-3 rounded-lg border border-slate-200 bg-surface px-3 py-3 shadow-sm transition ${dragIdx === i ? 'opacity-40' : ''} ${!r.active ? 'opacity-70' : ''}`}
            >
              <GripVertical size={16} className="mt-0.5 shrink-0 cursor-grab text-slate-400 active:cursor-grabbing" />
              <span className="mt-0.5 w-6 shrink-0 text-center text-xs font-medium text-slate-400">{i + 1}</span>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-900">{r.name}</span>
                  {!r.active && <StatusBadge status="PAUSED" />}
                </div>

                {/* Conditions → target, in one readable line. */}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                  <ConditionChips rule={r} />
                  <ArrowRight size={13} className="mx-0.5 text-slate-400" />
                  <TargetChip rule={r} />
                </div>
                {r.description && <p className="mt-1 text-xs text-slate-400">{r.description}</p>}
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <button className="btn-ghost !px-1.5" title="Move up" disabled={i === 0} onClick={() => move(i, i - 1)}>
                  <ArrowUp size={15} />
                </button>
                <button className="btn-ghost !px-1.5" title="Move down" disabled={i === items.length - 1} onClick={() => move(i, i + 1)}>
                  <ArrowDown size={15} />
                </button>
                <button className="btn-ghost !py-1 text-xs" onClick={() => setEditing(r)}>
                  <Pencil size={14} /> Edit
                </button>
                <button
                  className="btn-ghost !py-1 text-xs text-rose-600"
                  disabled={del.isPending}
                  onClick={() => { if (confirm(`Delete routing rule "${r.name}"?`)) del.mutate(r.id); }}
                >
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing !== undefined && (
        <RuleModal rule={editing} lookups={lookups} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); invalidate(); }} />
      )}
      {showTest && <TestModal lookups={lookups} onClose={() => setShowTest(false)} />}
    </div>
  );
}

function ConditionChips({ rule }: { rule: RoutingRule }) {
  const chips: string[] = [];
  if (rule.projectName ?? rule.projectId) chips.push(`Project: ${rule.projectName ?? '—'}`);
  if (rule.campaignName ?? rule.campaignId) chips.push(`Campaign: ${rule.campaignName ?? '—'}`);
  if (rule.sourceChannel) chips.push(`Channel: ${rule.sourceChannel.replace(/_/g, ' ')}`);
  if (rule.locations.length) chips.push(`Location: ${rule.locations.join(', ')}`);
  if (chips.length === 0) return <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">Any lead</span>;
  return (
    <>
      {chips.map((c) => (
        <span key={c} className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">{c}</span>
      ))}
    </>
  );
}

function TargetChip({ rule }: { rule: RoutingRule }) {
  if (rule.strategy === 'SPECIFIC_USER') {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-brand-50 px-1.5 py-0.5 font-medium text-brand-700">
        <UserIcon size={12} /> {rule.targetUser?.name ?? '(unset)'}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-brand-50 px-1.5 py-0.5 font-medium text-brand-700">
      <Users size={12} /> Round-robin · {rule.members.map((m) => m.name).join(', ') || '(empty pool)'}
    </span>
  );
}

// ── Rule create / edit modal ────────────────────────────────────────────────────

function RuleModal({
  rule, lookups, onClose, onSaved,
}: {
  rule: RoutingRule | null;
  lookups: ReturnType<typeof useLookups>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!rule;
  const [name, setName] = useState(rule?.name ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [active, setActive] = useState(rule?.active ?? true);
  const [projectId, setProjectId] = useState(rule?.projectId ?? '');
  const [campaignId, setCampaignId] = useState(rule?.campaignId ?? '');
  const [sourceChannel, setSourceChannel] = useState(rule?.sourceChannel ?? '');
  const [locationsText, setLocationsText] = useState((rule?.locations ?? []).join(', '));
  const [strategy, setStrategy] = useState<Strategy>(rule?.strategy ?? 'SPECIFIC_USER');
  const [targetUserId, setTargetUserId] = useState(rule?.targetUserId ?? '');
  const [memberIds, setMemberIds] = useState<string[]>(rule?.memberIds ?? []);
  const [error, setError] = useState('');

  const locations = useMemo(
    () => locationsText.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
    [locationsText],
  );

  const users: any[] = lookups.users.data ?? [];

  const mut = useMutation({
    mutationFn: async () => {
      const body = {
        name,
        description: description || undefined,
        active,
        projectId: projectId || null,
        campaignId: campaignId || null,
        sourceChannel: sourceChannel || null,
        locations,
        strategy,
        targetUserId: strategy === 'SPECIFIC_USER' ? targetUserId || null : null,
        memberIds: strategy === 'ROUND_ROBIN' ? memberIds : [],
      };
      return isEdit
        ? (await api.put(`/routing/rules/${rule!.id}`, body)).data
        : (await api.post('/routing/rules', body)).data;
    },
    onSuccess: onSaved,
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const targetValid = strategy === 'SPECIFIC_USER' ? !!targetUserId : memberIds.length > 0;
  const canSave = name.trim().length >= 2 && targetValid && !mut.isPending;

  function toggleMember(id: string) {
    setMemberIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? `Edit rule — ${rule!.name}` : 'New Routing Rule'}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!canSave} onClick={() => mut.mutate()}>
            {mut.isPending ? 'Saving…' : isEdit ? 'Save' : 'Create Rule'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}

        <Field label="Rule name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Whitefield leads → North team" />
        </Field>

        <div className="rounded-lg border border-slate-200 p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">When a lead matches</div>
          <p className="mb-3 text-xs text-slate-400">Leave a condition blank to ignore it. All set conditions must match.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Project interest">
              <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">Any project</option>
                {(lookups.projects.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Campaign">
              <select className="input" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                <option value="">Any campaign</option>
                {(lookups.campaigns.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Source channel">
              <select className="input" value={sourceChannel} onChange={(e) => setSourceChannel(e.target.value)}>
                <option value="">Any channel</option>
                {CHANNELS.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
              </select>
            </Field>
            <Field label="Locations (comma-separated)">
              <input className="input" value={locationsText} onChange={(e) => setLocationsText(e.target.value)} placeholder="Whitefield, Bengaluru" />
            </Field>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Route to</div>
          <div className="mb-3 flex gap-2">
            {(['SPECIFIC_USER', 'ROUND_ROBIN'] as Strategy[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStrategy(s)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${strategy === s ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}
              >
                {s === 'SPECIFIC_USER' ? 'One salesperson' : 'Team (round-robin)'}
              </button>
            ))}
          </div>

          {strategy === 'SPECIFIC_USER' ? (
            <Field label="Salesperson">
              <select className="input" value={targetUserId} onChange={(e) => setTargetUserId(e.target.value)}>
                <option value="">Select a salesperson…</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </Field>
          ) : (
            <div>
              <span className="label">Team pool (least-loaded member gets the lead)</span>
              <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
                {users.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">No users available.</div>}
                {users.map((u) => (
                  <label key={u.id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50">
                    <input type="checkbox" className="accent-brand-600" checked={memberIds.includes(u.id)} onChange={() => toggleMember(u.id)} />
                    <span className="text-slate-700">{u.name}</span>
                    <span className="text-xs text-slate-400">{u.role ?? u.roleName ?? ''}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <Field label="Description (optional)">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>

        {isEdit && (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" className="accent-brand-600" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Active
          </label>
        )}
      </div>
    </Modal>
  );
}

// ── Test / dry-run modal ────────────────────────────────────────────────────────

function TestModal({ lookups, onClose }: { lookups: ReturnType<typeof useLookups>; onClose: () => void }) {
  const [projectId, setProjectId] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [sourceChannel, setSourceChannel] = useState('');
  const [location, setLocation] = useState('');
  const [result, setResult] = useState<any | null>(null);
  const [error, setError] = useState('');

  const mut = useMutation({
    mutationFn: async () =>
      (await api.post('/routing/test', {
        projectId: projectId || null,
        campaignId: campaignId || null,
        sourceChannel: sourceChannel || null,
        location: location || undefined,
      })).data,
    onSuccess: (data) => { setResult(data); setError(''); },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Test routing"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Close</button>
          <button className="btn-primary" disabled={mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? 'Evaluating…' : 'Evaluate'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-500">Describe a hypothetical lead and see exactly who it would be assigned to and why.</p>
        {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Project interest">
            <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">—</option>
              {(lookups.projects.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Campaign">
            <select className="input" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
              <option value="">—</option>
              {(lookups.campaigns.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Source channel">
            <select className="input" value={sourceChannel} onChange={(e) => setSourceChannel(e.target.value)}>
              <option value="">—</option>
              {CHANNELS.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
            </select>
          </Field>
          <Field label="Location">
            <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Whitefield" />
          </Field>
        </div>

        {result && (
          <div className="space-y-3">
            <Card className="!p-3">
              {result.result ? (
                <div className="text-sm">
                  <div className="font-medium text-slate-900">
                    Assigned to {result.result.owner?.name ?? '—'}
                  </div>
                  <div className="mt-0.5 text-slate-500">{result.result.reason}</div>
                </div>
              ) : (
                <div className="text-sm text-rose-600">No owner could be resolved (no rule, agent, or fallback available).</div>
              )}
            </Card>

            <div>
              <div className="label">Rule evaluation</div>
              {(result.evaluations ?? []).length === 0 ? (
                <p className="text-sm text-slate-400">No active rules configured.</p>
              ) : (
                <ul className="space-y-1.5">
                  {result.evaluations.map((e: any) => (
                    <li key={e.ruleId} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-1.5 text-sm">
                      <span className="text-slate-700">{e.name}</span>
                      {e.matched ? (
                        <span className="text-xs font-medium text-emerald-600">✓ matched</span>
                      ) : (
                        <span className="text-xs text-slate-400">{e.skipReason ?? 'skipped'}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
