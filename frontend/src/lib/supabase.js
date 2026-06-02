import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://iocbitubsokjitkxmlxk.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlvY2JpdHVic29raml0a3htbHhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwNDQzNTAsImV4cCI6MjA5MDYyMDM1MH0.VUg6IWy3Vx3kIGhrQoTdMiZ3bYMCd9zaxkidHTE2SMk'

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
