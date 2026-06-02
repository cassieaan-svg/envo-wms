import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables')
}

// Service role client - use for backend operations (bypasses RLS)
export const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

// Helper function to verify JWT from frontend
export async function verifyToken(token) {
  try {
    const { data, error } = await sbAdmin.auth.getUser(token)
    if (error) throw error
    return data.user
  } catch (err) {
    return null
  }
}
