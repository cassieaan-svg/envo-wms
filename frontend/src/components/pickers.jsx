import { useEffect, useMemo, useRef, useState } from 'react';
import { Field } from './ui.jsx';

// Two controls: the group (LGA / category), then the item itself.
//
// The item control is a combobox rather than a native <select> — the search lives inside
// its popup, so a long list can be typed into rather than scrolled. That replaces the old
// separate Search field, which sat outside the dropdown and silently fought the group
// filter.
//
// The combobox is not gated on choosing a group: with none chosen it searches everything
// (so a facility can still be found when its LGA isn't known), and with one chosen it
// lists only that group. The group name is appended to an option only when the list spans
// groups — never repeated once the list is already scoped to one.

function listGroups(items, groupOf) {
  const seen = new Set();
  for (const item of items) {
    const key = groupOf(item);
    if (key) seen.add(key);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function Combobox({ items, value, onChange, placeholder, searchPlaceholder, metaOf }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapRef = useRef(null);
  const searchRef = useRef(null);

  const selected = items.find((i) => String(i.id) === String(value)) || null;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.name.toLowerCase().includes(q));
  }, [items, search]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    searchRef.current?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function pick(id) {
    onChange(String(id));
    setOpen(false);
    setSearch('');
  }

  return (
    <div className="combo" ref={wrapRef}>
      <button
        type="button"
        className="combo-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={selected ? '' : 'muted'}>{selected ? selected.name : placeholder}</span>
        <span className="combo-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="combo-pop">
          <input
            ref={searchRef}
            className="combo-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={searchPlaceholder}
          />
          <div className="combo-list">
            {visible.length === 0 ? (
              <div className="combo-empty">nothing matches</div>
            ) : (
              visible.map((item) => {
                const meta = metaOf?.(item);
                return (
                  <button
                    type="button"
                    key={item.id}
                    className={`combo-option ${String(item.id) === String(value) ? 'on' : ''}`}
                    onClick={() => pick(item.id)}
                  >
                    <span>{item.name}</span>
                    {meta && <span className="muted">{meta}</span>}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Picker({
  items,
  groupOf,
  value,
  onChange,
  groupLabel,
  groupPlaceholder,
  itemLabel,
  itemPlaceholder,
  searchPlaceholder,
  metaOf,
  // A second, independent narrowing dimension — e.g. facility level — rendered as its own
  // select before the group. Optional: omitted entirely when a picker has only one axis.
  filterLabel,
  filterPlaceholder,
  filterOf,
  filterOptions,
}) {
  const [group, setGroup] = useState('');
  const [filterValue, setFilterValue] = useState('');

  const filtered = useMemo(
    () => (filterOf && filterValue ? items.filter((i) => filterOf(i) === filterValue) : items),
    [items, filterOf, filterValue]
  );

  const groups = useMemo(() => listGroups(filtered, groupOf), [filtered, groupOf]);
  const scoped = useMemo(
    () => (group ? filtered.filter((i) => groupOf(i) === group) : filtered),
    [filtered, groupOf, group]
  );

  return (
    <div className="picker-filters">
      {filterOf && (
        <Field label={filterLabel}>
          <select
            value={filterValue}
            onChange={(e) => {
              setFilterValue(e.target.value);
              // The chosen LGA may not exist under the new level (or may now mean a
              // different set of facilities), so it's cleared along with the selection.
              setGroup('');
              if (value) onChange('');
            }}
          >
            <option value="">{filterPlaceholder}</option>
            {filterOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label={groupLabel}>
        <select
          value={group}
          onChange={(e) => {
            setGroup(e.target.value);
            // Drop a selection made under the previous group so it can't linger unseen.
            if (value) onChange('');
          }}
        >
          <option value="">{groupPlaceholder}</option>
          {groups.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </Field>

      <Field label={itemLabel}>
        <Combobox
          items={scoped}
          value={value}
          onChange={onChange}
          placeholder={itemPlaceholder}
          searchPlaceholder={searchPlaceholder}
          metaOf={(item) => metaOf?.(item, { group })}
        />
      </Field>
    </div>
  );
}

export function CommodityPicker({ commodities, value, onChange, metaOf }) {
  return (
    <Picker
      items={commodities}
      groupOf={(c) => c.category}
      value={value}
      onChange={onChange}
      groupLabel="Category"
      groupPlaceholder="all categories"
      itemLabel="Commodity"
      itemPlaceholder="select commodity…"
      searchPlaceholder="search commodities…"
      metaOf={(c, ctx) => {
        const own = metaOf?.(c, ctx);
        if (own) return own;
        return ctx.group ? null : c.category;
      }}
    />
  );
}

const FACILITY_LEVELS = [
  { value: 'primary', label: 'Primary' },
  { value: 'secondary', label: 'Secondary' },
];

export function FacilityPicker({ facilities, value, onChange }) {
  return (
    <Picker
      items={facilities}
      groupOf={(f) => f.lga}
      value={value}
      onChange={onChange}
      groupLabel="LGA"
      groupPlaceholder="all LGAs"
      itemLabel="Facility"
      itemPlaceholder="select facility…"
      searchPlaceholder="search facilities…"
      metaOf={(f, ctx) => (ctx.group ? null : f.lga)}
      filterLabel="Level"
      filterPlaceholder="primary & secondary"
      filterOf={(f) => f.facility_type}
      filterOptions={FACILITY_LEVELS}
    />
  );
}
