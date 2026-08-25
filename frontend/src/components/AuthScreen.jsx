import { useState } from 'react'
import { auth } from '../lib/api'
import { useAppStore } from '../store/appStore'
import { hydrateSession } from '../utils/session'

export function AuthScreen({ onSuccess }) {
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw]     = useState(false)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')
  const store = useAppStore()

  const handleSignIn = async (e) => {
    e?.preventDefault()
    if (!email || !password) { setError('Please enter your username and password.'); return }
    setError(''); setLoading(true)

    try {
      const fullEmail = email.trim().toLowerCase().includes('@')
        ? email.trim().toLowerCase()
        : email.trim().toLowerCase() + '@envo.ng'
      const user = await auth.login(fullEmail, password)

      // Build the store from the authenticated user (shared with refresh path)
      const { facilityRole } = await hydrateSession(user)

      // On a fresh sign-in, SDP/DSD users land on the dispense page
      if (facilityRole === 'sdp' || facilityRole === 'dsd') store.setCurrentPage('dispense')

      onSuccess()
    } catch (err) {
      setError(err.message || 'Sign in failed.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="bg-gray-900 border border-white/10 rounded-2xl p-8">
          {/* Logo */}
          <div className="text-center mb-7">
            <div className="w-14 h-14 bg-green-500 rounded-2xl inline-flex items-center justify-center text-2xl mb-3">⬡</div>
            <h1 className="text-xl font-semibold text-gray-100">EnVo</h1>
            {/* Not "HIV Programme…": EnVo now hosts more than one commodity programme,
                and the sign-in screen comes BEFORE the module is chosen — so naming one
                programme here is wrong for anyone signing in to work in the other. */}
            <p className="text-sm text-gray-500 mt-1">Logistics Management</p>
          </div>

          <form onSubmit={handleSignIn} className="space-y-4">
            <div>
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Username</label>
              <input
                type="text"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="username"
                autoComplete="username"
                className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2.5 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">Password</label>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2.5 pr-10 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 text-base"
                >
                  {showPw ? '🙈' : '👁'}
                </button>
              </div>
            </div>

            {error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2.5 text-sm text-red-400">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-green-500 hover:bg-green-400 disabled:opacity-50 text-white font-semibold rounded-lg py-3 text-sm transition-colors min-h-[44px]"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
