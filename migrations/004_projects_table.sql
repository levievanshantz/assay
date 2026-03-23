-- Migration 004: Projects table for V2 project hierarchy
-- Run this in Supabase SQL Editor

-- 1. Create projects table
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  product_id CHARACTER VARYING REFERENCES products(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Enable RLS
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON projects
  FOR ALL USING (true) WITH CHECK (true);

-- 3. Index for product lookups
CREATE INDEX IF NOT EXISTS projects_product_idx ON projects (product_id);
CREATE INDEX IF NOT EXISTS projects_status_idx ON projects (status);
