import { useState } from 'react'
import { sb } from '../lib/supabase'
import { useAppStore } from '../store/appStore'
import { toast } from './ui/Toast'

const MIN_LEN = 8

// Self-service password change for the logged-in user. Re-verifies the current
// password (important if an account was compromised) before updating, using the
// session's own email — no service-role key or backend needed.
export function ChangePasswordModal({ onClose }) {
  const user = useAppStore(s => s.user)
  const [current, setCurrent] = useState('')
  const [next, setNext]       = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPw, setShowPw]   = useState(false)
  const [saving, setSaving]   = useState(false)
  const [err, setErr]         = useState('')

  function validate() {
    if (!current || !next || !confirm) return 'Fill in all fields.'
    if (next.length < MIN_LEN)        return `New password must be at least ${MIN_LEN} characters.`
    if (next !== confirm)             return 'New password and confirmation do not match.'
    if (next === current)             return 'New password must be different from the current one.'
    return ''
  }

  async function submit(e) {
    e?.preventDefault()
    const v = validate()
    if (v) { setErr(v); return }
    setErr('')
    setSaving(true)

    // Re-verify the current password against the session's email so a stolen
    // session can't silently change the password without knowing the old one.
    if (user?.email) {
      const { error: verifyErr } = await sb.auth.signInWithPassword({ email: user.email, password: current })
      if (verifyErr) {
        setSaving(false)
        setErr('Current password is incorrect.')
        return
      }
    }

    const { error } = await sb.auth.updateUser({ password: next })
    setSaving(false)
    if (error) { setErr(error.message || 'Could not update password.'); return }

    toast('Password changed', 'green')
    onClose()
  }

  const inputCls = 'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500'

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="bg-gray-900 border border-white/10 rounded-2xl p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-medium text-gray-100">Change password</h3>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Current password</label>
            <input type={showPw ? 'text' : 'password'} value={current} onChange={e => setCurrent(e.target.value)}
              autoComplete="current-password" className={inputCls} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">New password</label>
            <input type={showPw ? 'text' : 'password'} value={next} onChange={e => setNext(e.target.value)}
              autoComplete="new-password" className={inputCls} />
            <p className="text-[11px] text-gray-600 mt-1">At least {MIN_LEN} characters.</p>
          </div>
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Confirm new password</label>
            <input type={showPw ? 'text' : 'password'} value={confirm} onChange={e => setConfirm(e.target.value)}
              autoComplete="new-password" className={inputCls} />
          </div>

          <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
            <input type="checkbox" checked={showPw} onChange={e => setShowPw(e.target.checked)} className="w-3.5 h-3.5 cursor-pointer" />
            Show passwords
          </label>

          {err && <p className="text-xs text-red-400">{err}</p>}
        </div>

        <div className="flex gap-2 mt-5">
          <button type="submit" disabled={saving}
            className="flex-1 bg-green-500 hover:bg-green-400 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors">
            {saving ? 'Saving…' : 'Update password'}
          </button>
          <button type="button" onClick={onClose} disabled={saving}
            className="border border-white/10 text-gray-400 hover:text-gray-200 rounded-lg px-4 py-2 text-sm transition-colors">
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
