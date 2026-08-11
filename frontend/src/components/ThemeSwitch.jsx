// Three-up System / Light / Dark switch, same shape as EnVo's. 'system' follows the OS and
// keeps following it live if the user flips their system setting.
const OPTIONS = [
  ['system', '🖥', 'System'],
  ['light', '☀', 'Light'],
  ['dark', '🌙', 'Dark'],
];

export default function ThemeSwitch({ theme, onChange }) {
  return (
    <div className="theme-switch">
      {OPTIONS.map(([value, icon, label]) => (
        <button
          key={value}
          type="button"
          title={`${label} theme`}
          className={theme === value ? 'on' : ''}
          onClick={() => onChange(value)}
        >
          <span aria-hidden="true">{icon}</span>
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
