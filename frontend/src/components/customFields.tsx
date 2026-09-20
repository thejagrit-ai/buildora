import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiErrorMessage } from '../api/client';
import { Card, Field, Spinner } from './ui';

// Objects that support admin-defined custom fields (must match the backend enum).
export type CustomObjectType = 'ACCOUNT' | 'OPPORTUNITY' | 'LEAD' | 'SITE_VISIT';

export const OBJECT_LABELS: Record<CustomObjectType, string> = {
  ACCOUNT: 'Account',
  OPPORTUNITY: 'Opportunity',
  LEAD: 'Lead',
  SITE_VISIT: 'Site Visit',
};

export interface CustomFieldDef {
  id: string;
  objectType: CustomObjectType;
  label: string;
  apiName: string;
  fieldType: string;
  required: boolean;
  options: string[] | null;
  helpText: string | null;
  order: number;
  active: boolean;
}

// The data-type catalogue shown in the field-creation picker.
export const FIELD_TYPE_META: { type: string; label: string; desc: string }[] = [
  { type: 'TEXT', label: 'Text', desc: 'Allows users to enter a single line of text.' },
  { type: 'TEXTAREA', label: 'Text Area', desc: 'Allows users to enter multiple lines of text.' },
  { type: 'NUMBER', label: 'Number', desc: 'Allows users to enter any number. Leading zeros are removed.' },
  { type: 'CURRENCY', label: 'Currency', desc: 'Allows users to enter a currency amount.' },
  { type: 'PERCENT', label: 'Percent', desc: "Allows users to enter a percentage; adds a '%' sign." },
  { type: 'CHECKBOX', label: 'Checkbox', desc: 'Allows users to select a True (checked) or False (unchecked) value.' },
  { type: 'DATE', label: 'Date', desc: 'Allows users to enter a date or pick one from a calendar.' },
  { type: 'DATETIME', label: 'Date/Time', desc: 'Allows users to enter a date and time.' },
  { type: 'EMAIL', label: 'Email', desc: 'Allows users to enter an email address, validated for format.' },
  { type: 'PHONE', label: 'Phone', desc: 'Allows users to enter a phone number.' },
  { type: 'URL', label: 'URL', desc: 'Allows users to enter a web address (URL).' },
  { type: 'PICKLIST', label: 'Picklist', desc: 'Allows users to select from a dropdown of values you define.' },
];

export function fieldTypeLabel(type: string): string {
  return FIELD_TYPE_META.find((m) => m.type === type)?.label ?? type;
}

export function useCustomFieldDefs(objectType: CustomObjectType, opts?: { all?: boolean }) {
  return useQuery({
    queryKey: ['custom-field-defs', objectType, opts?.all ?? false],
    queryFn: async () =>
      (await api.get('/custom-fields/definitions', {
        params: { objectType, ...(opts?.all ? { all: 'true' } : {}) },
      })).data as CustomFieldDef[],
  });
}

// A single input control appropriate to the field's data type.
function CustomFieldInput({
  def, value, onChange,
}: { def: CustomFieldDef; value: any; onChange: (v: any) => void }) {
  switch (def.fieldType) {
    case 'TEXTAREA':
      return <textarea className="input min-h-[80px]" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'CHECKBOX':
      return <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
    case 'NUMBER':
    case 'CURRENCY':
    case 'PERCENT':
      return (
        <input
          type="number"
          className="input"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
    case 'DATE':
      return <input type="date" className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} />;
    case 'DATETIME':
      return <input type="datetime-local" className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} />;
    case 'EMAIL':
      return <input type="email" className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'URL':
      return <input type="url" className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder="https://…" />;
    case 'PHONE':
      return <input type="tel" className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'PICKLIST':
      return (
        <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {(def.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    default:
      return <input className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
}

// Controlled inputs for create/edit modals. Renders nothing if no fields exist.
export function CustomFieldInputs({
  objectType, values, onChange,
}: { objectType: CustomObjectType; values: Record<string, any>; onChange: (v: Record<string, any>) => void }) {
  const defs = useCustomFieldDefs(objectType);
  if (defs.isLoading || !defs.data?.length) return null;
  return (
    <>
      {defs.data.map((d) => (
        <Field key={d.id} label={`${d.label}${d.required ? ' *' : ''}`}>
          <CustomFieldInput def={d} value={values[d.apiName]} onChange={(v) => onChange({ ...values, [d.apiName]: v })} />
          {d.helpText && <p className="mt-1 text-xs text-slate-400">{d.helpText}</p>}
        </Field>
      ))}
    </>
  );
}

// Persist a values map for a record that already exists (e.g. after create).
export async function saveCustomFieldValues(
  objectType: CustomObjectType,
  recordId: string,
  values: Record<string, any>,
) {
  if (!values || Object.keys(values).length === 0) return;
  await api.put(`/custom-fields/values/${objectType}/${recordId}`, { values });
}

// Self-contained editor for detail drawers: loads definitions + values, edits,
// and saves. Renders nothing when no custom fields are configured for the object.
export function CustomFieldsPanel({
  objectType, recordId,
}: { objectType: CustomObjectType; recordId: string }) {
  const queryClient = useQueryClient();
  const defs = useCustomFieldDefs(objectType);
  const valuesQ = useQuery({
    queryKey: ['custom-field-values', objectType, recordId],
    queryFn: async () => (await api.get(`/custom-fields/values/${objectType}/${recordId}`)).data as Record<string, any>,
    enabled: !!recordId,
  });

  const [draft, setDraft] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const values = draft ?? valuesQ.data ?? {};

  const mut = useMutation({
    mutationFn: async () => (await api.put(`/custom-fields/values/${objectType}/${recordId}`, { values })).data,
    onSuccess: (data) => {
      setDraft(null);
      setSaved(true);
      setError('');
      queryClient.setQueryData(['custom-field-values', objectType, recordId], data);
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  if (defs.isLoading || !defs.data?.length) return null;

  return (
    <Card className="!p-4">
      <h4 className="mb-2 font-semibold text-slate-800">Custom fields</h4>
      {valuesQ.isLoading ? (
        <Spinner />
      ) : (
        <div className="space-y-3">
          {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}
          {defs.data.map((d) => (
            <Field key={d.id} label={d.label}>
              <CustomFieldInput
                def={d}
                value={values[d.apiName]}
                onChange={(v) => { setSaved(false); setDraft({ ...values, [d.apiName]: v }); }}
              />
              {d.helpText && <p className="mt-1 text-xs text-slate-400">{d.helpText}</p>}
            </Field>
          ))}
          <div className="flex items-center justify-end gap-2">
            {saved && <span className="text-xs text-emerald-600">Saved</span>}
            <button className="btn-outline" disabled={mut.isPending || draft === null} onClick={() => mut.mutate()}>
              {mut.isPending ? 'Saving…' : 'Save custom fields'}
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
