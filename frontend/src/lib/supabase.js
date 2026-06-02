import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    'Missing Supabase configuration. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY ' +
    '(see frontend/.env.example). For local dev, copy .env.example to .env and fill in your values. ' +
    'On Netlify, add them under Site settings → Environment variables.'
  )
}

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
