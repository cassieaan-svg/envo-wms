import { money, qty } from './ui.jsx';

// One commodity line on the dispatch form. The commodity itself is chosen from the picker
// above rather than a per-row dropdown, so here it's just a label. Unit price is prefilled
// from the catalogue price but stays editable, since a dispatch may be priced differently.
export default function DispatchLineEditor({ line, commodity, onChange, onRemove, disabled }) {
  const onHand = commodity ? Number(commodity.on_hand) : null;
  const quantity = Number(line.quantity) || 0;
  const lineTotal = quantity * (Number(line.unitPrice) || 0);
  const short = onHand != null && quantity > onHand;

  return (
    <tr>
      <td className="wrap">
        <div>{commodity?.name || '—'}</div>
        {commodity?.category && <div className="muted small">{commodity.category}</div>}
      </td>
      <td className="num muted">
        {onHand == null ? '—' : `${qty(onHand)} ${commodity?.unit || ''}`.trim()}
      </td>
      <td>
        <input
          type="number"
          min="0.01"
          step="0.01"
          value={line.quantity}
          onChange={(e) => onChange({ ...line, quantity: e.target.value })}
          disabled={disabled}
          style={{ width: 100, textAlign: 'right', borderColor: short ? 'var(--danger)' : undefined }}
        />
        {short && (
          <div style={{ color: 'var(--danger)', fontSize: 12 }}>only {qty(onHand)} available</div>
        )}
      </td>
      <td>
        <input
          type="number"
          min="0"
          step="0.01"
          value={line.unitPrice}
          onChange={(e) => onChange({ ...line, unitPrice: e.target.value })}
          disabled={disabled}
          style={{ width: 110, textAlign: 'right' }}
        />
      </td>
      <td className="num">{money(lineTotal)}</td>
      <td>
        <button className="btn small danger" type="button" onClick={onRemove} disabled={disabled}>
          remove
        </button>
      </td>
    </tr>
  );
}
