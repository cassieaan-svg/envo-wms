import { useEffect, useState } from 'react'

let toastFn = null
export function toast(msg, type = '') { toastFn?.(msg, type) }

export function Toast() {
  const [state, setState] = useState({ msg: '', type: '', visible: false })

  useEffect(() => {
    toastFn = (msg, type) => {
      setState({ msg, type, visible: true })
      setTimeout(() => setState(s => ({ ...s, visible: false })), 3500)
    }
  }, [])

  const colors = {
    green: 'border-green-500/40 text-green-400',
    red:   'border-red-500/40 text-red-400',
    amber: 'border-amber-500/40 text-amber-400',
    '':    'border-white/15 text-gray-200',
  }

  return (
    <div className={`fixed bottom-6 right-6 bg-gray-900 border rounded-xl px-4 py-3 text-sm z-50
      transition-all duration-300 max-w-xs
      ${state.visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'}
      ${colors[state.type] || colors['']}`}>
      {state.msg}
    </div>
  )
}
