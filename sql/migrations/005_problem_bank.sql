-- Migration 005: Physics Problem Bank
-- Adds tables for a multi-source physics problem bank (IPhO, USAPhO, Irodov, etc.)

CREATE TABLE bank_sources (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  url VARCHAR(255),
  country VARCHAR(100),
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE bank_problems (
  id SERIAL PRIMARY KEY,
  source_id INTEGER REFERENCES bank_sources(id),
  year INTEGER,
  problem_number VARCHAR(50),
  title VARCHAR(255),
  statement_en TEXT,
  statement_ru TEXT,
  solution_en TEXT,
  solution_ru TEXT,
  difficulty INTEGER CHECK (difficulty BETWEEN 1 AND 10),
  topics TEXT[] DEFAULT '{}',
  submitted_by INTEGER REFERENCES users(id),
  reviewed BOOLEAN DEFAULT false,
  reviewed_by INTEGER REFERENCES users(id),
  view_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE bank_attempts (
  user_id INTEGER REFERENCES users(id),
  problem_id INTEGER REFERENCES bank_problems(id),
  status VARCHAR(20) CHECK (status IN ('attempted', 'solved', 'gave_up')),
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, problem_id)
);

CREATE TABLE bank_difficulty_votes (
  user_id INTEGER REFERENCES users(id),
  problem_id INTEGER REFERENCES bank_problems(id),
  difficulty INTEGER CHECK (difficulty BETWEEN 1 AND 10),
  PRIMARY KEY (user_id, problem_id)
);

CREATE TABLE bank_comments (
  id SERIAL PRIMARY KEY,
  problem_id INTEGER REFERENCES bank_problems(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  content TEXT NOT NULL,
  parent_id INTEGER REFERENCES bank_comments(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_bank_problems_source ON bank_problems(source_id);
CREATE INDEX idx_bank_problems_topics ON bank_problems USING GIN(topics);
CREATE INDEX idx_bank_problems_difficulty ON bank_problems(difficulty);
CREATE INDEX idx_bank_problems_year ON bank_problems(year DESC);

INSERT INTO bank_sources (name, slug, description, country, sort_order) VALUES
  ('International Physics Olympiad', 'ipho', 'Problems from the International Physics Olympiad (1967-present)', 'International', 1),
  ('Asian Physics Olympiad', 'apho', 'Problems from the Asian Physics Olympiad', 'International', 2),
  ('European Physics Olympiad', 'eupho', 'Problems from the European Physics Olympiad', 'International', 3),
  ('USAPhO', 'usapho', 'USA Physics Olympiad problems', 'United States', 4),
  ('BPhO', 'bpho', 'British Physics Olympiad problems', 'United Kingdom', 5),
  ('Irodov', 'irodov', 'Problems in General Physics by I.E. Irodov', 'Russia', 6),
  ('User Submitted', 'user', 'Community-contributed original problems', 'International', 99);
