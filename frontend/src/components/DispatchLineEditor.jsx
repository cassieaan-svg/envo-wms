import { money, qty } from './ui.jsx';

// One commodity line on the dispatch form. Unit price is prefilled from the commodity's
// current catalogue price but stays editable, since a dispatch may be priced differently.
export default function DispatchLineEditor({ line, commodities, onChange, onRemove, disabled }) {
  const commodity = commodities.find((c) => String(c.id) === String(line.commodityId));
  const onHand = commodity ? Number(commodity.on_hand) : null;
  const quantity = Number(line.quantity) || 0;
  const lineTotal = quantity * (Number(line.unitPrice) || 0);
  const short = onHand != null && quantity > onHand;

  function pickCommodity(id) {
    const picked = commodities.find((c) => String(c.id) === String(id));
    // Default to the cheapest current price when a commodity has several vendors.
    const prices = picked?.current_prices || [];
    const best = prices.length
      ? prices.reduce((a, b) => (Number(a.unitPrice) <= Number(b.unitPrice) ? a : b))
      : null;
    onChange({ ...line, commodityId: id, unitPrice: best ? String(best.unitPrice) : line.unitPrice });
  }

  return (
    <tr>
      <td className="wrap">
        <select
          value={line.commodityId}
          onChange={(e) => pickCommodity(e.target.value)}
          disabled={disabled}
          style={{ minWidth: 240 }}
        >
          <option value="">select commodity…</option>
          {commodities.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.category ? ` · ${c.category}` : ''}
            </option>
          ))}
        </select>
      </td>
      <td className="num muted">{onHand == null ? '—' : qty(onHand)}</td>
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
