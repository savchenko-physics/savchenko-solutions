-- 007_challenges_paths.sql
-- Weekly Challenges + Study Paths

CREATE TABLE challenges (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255),
  problem_statement TEXT NOT NULL,
  solution TEXT,
  difficulty INTEGER CHECK (difficulty BETWEEN 1 AND 10),
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE challenge_submissions (
  id SERIAL PRIMARY KEY,
  challenge_id INTEGER REFERENCES challenges(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) NOT NULL,
  content TEXT NOT NULL,
  is_correct BOOLEAN,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TIMESTAMP,
  submitted_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(challenge_id, user_id)
);

CREATE TABLE challenge_leaderboard (
  user_id INTEGER REFERENCES users(id) PRIMARY KEY,
  total_solved INTEGER DEFAULT 0,
  current_streak INTEGER DEFAULT 0,
  longest_streak INTEGER DEFAULT 0,
  total_score INTEGER DEFAULT 0
);

CREATE TABLE study_paths (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  author_id INTEGER REFERENCES users(id),
  difficulty_start INTEGER,
  difficulty_end INTEGER,
  estimated_hours INTEGER,
  problem_count INTEGER DEFAULT 0,
  is_published BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE path_problems (
  id SERIAL PRIMARY KEY,
  path_id INTEGER REFERENCES study_paths(id) ON DELETE CASCADE,
  problem_type VARCHAR(20) CHECK (problem_type IN ('savchenko', 'bank', 'challenge')),
  problem_ref VARCHAR(50) NOT NULL,
  sort_order INTEGER NOT NULL,
  notes TEXT
);

CREATE TABLE user_path_progress (
  user_id INTEGER REFERENCES users(id),
  path_id INTEGER REFERENCES study_paths(id),
  problem_ref VARCHAR(50),
  status VARCHAR(20) CHECK (status IN ('not_started', 'attempted', 'solved')) DEFAULT 'not_started',
  completed_at TIMESTAMP,
  PRIMARY KEY (user_id, path_id, problem_ref)
);

-- Indexes for common queries
CREATE INDEX idx_challenges_active ON challenges(is_active, week_start, week_end);
CREATE INDEX idx_challenge_submissions_challenge ON challenge_submissions(challenge_id);
CREATE INDEX idx_challenge_submissions_user ON challenge_submissions(user_id);
CREATE INDEX idx_challenge_leaderboard_score ON challenge_leaderboard(total_score DESC);
CREATE INDEX idx_study_paths_published ON study_paths(is_published);
CREATE INDEX idx_study_paths_slug ON study_paths(slug);
CREATE INDEX idx_path_problems_path ON path_problems(path_id, sort_order);
CREATE INDEX idx_path_problems_ref ON path_problems(problem_ref);
CREATE INDEX idx_user_path_progress_user ON user_path_progress(user_id);

-- Seed 5 study paths (author_id=28 = astrosander)
INSERT INTO study_paths (title, slug, description, author_id, difficulty_start, difficulty_end, estimated_hours, problem_count, is_published)
VALUES
  ('Savchenko Starter Set', 'savchenko-starter-set',
   'A gentle introduction to Savchenko''s collection. 20 of the most accessible problems across all chapters, perfect for students just starting out with olympiad-level physics.',
   28, 3, 5, 10, 20, true),
  ('Mechanics Mastery', 'mechanics-mastery',
   'Build a strong foundation in classical mechanics. 30 problems from Kinematics and Dynamics (Chapters 1-2), ordered from straightforward to challenging.',
   28, 3, 9, 20, 30, true),
  ('IPhO Preparation: Thermodynamics', 'ipho-prep-thermodynamics',
   'Focused training for international olympiad thermodynamics. 25 problems mixing Savchenko Chapter 5 (Molecular Physics) with supplementary bank problems.',
   28, 5, 9, 18, 25, true),
  ('From Zero to National Olympiad', 'zero-to-national',
   'A comprehensive 50-problem journey from basics to competition level. Covers all major topics, building difficulty gradually to prepare for national-level physics olympiads.',
   28, 2, 8, 35, 50, true),
  ('The Hardest Savchenko Problems', 'hardest-savchenko',
   'Only for the brave. 20 notoriously difficult problems that challenge even the most experienced physics students. Think carefully before you begin.',
   28, 8, 10, 30, 20, true);

-- Seed path problems

-- 1. Savchenko Starter Set (20 easiest across chapters)
INSERT INTO path_problems (path_id, problem_type, problem_ref, sort_order, notes) VALUES
  ((SELECT id FROM study_paths WHERE slug='savchenko-starter-set'), 'savchenko', '1.1.1', 1, 'Warm-up: constant speed motion'),
  ((SELECT id FROM study_paths WHERE slug='savchenko-starter-set'), 'savchenko', '1.1.2', 2, 'Basic kinematics'),
  ((SELECT id FROM study_paths WHERE slug='savchenko-starter-set'), 'savchenko', '1.2.1', 3, 'Variable speed introduction'),
  ((SELECT id FROM study_paths WHERE slug='savchenko-starter-set'), 'savchenko', '2.1.1', 4, 'Newton''s laws basics'),
  ((SELECT id FROM study_paths WHERE slug='savchenko-starter-set'), 'savchenko', '2.1.2', 5, 'Force and acceleration'),
  ((SELECT id FROM study_paths WHERE slug='savchenko-starter-set'), 'savchenko', '2.2.1', 6, 'Momentum conservation'),
  ((SELECT id FROM study_paths WHERE slug='savchenko-starter-set'), 'savchenko', '2.3.1', 7, 'Work-energy theorem'),
  ((SELECT id FROM study_paths WHERE slug='savchenko-starter-set'), 'savchenko', '3.1.1', 8, 'Simple harmonic motion'),
  ((SELECT id FROM study_paths WHERE slug='savchenko-starter-set'), 'savchenko', '3.2.1', 9, 'Period and frequency'),
  ((SELECT id FROM study_paths WHERE slug='savchenko-starter-set'), 'savchenko', '4.1.1', 10, 'Fluid pressure basics'),
  ((SELECT id FROM study_paths WHERE slug='savchenko-starter-set'), 'savchenko', '4.2.1', 11, 'Archimedes'' law'),
  ((SELECT id FROM study_paths WHERE slug='savchenko-starter-set'), 'savchenko', '5.1.1', 12, 'Thermal motion introduction'),
  ((SELECT id FROM study_paths WHERE slug='savchenko-starter-set'), 'savchenko', '5.5.1', 13, 'Ideal gas equation'),
  ((SELECT id FROM study_paths WHERE slug='savchenko-starter-set'), 'savchenko', '6.1.1', 14, 'Coulomb''s law'),
  ((SELECT id FROM study_paths WHERE slug='savchenko-starter-set'), 'savchenko', '6.2.1', 15, 'Electric flux'),
  ((SELECT id FROM study_paths WHERE slug='savchenko-starter-set'), 'savchenko', '7.1.1', 16, 'Charged particle motion'),
  ((SELECT id FROM study_paths WHERE slug='savchenko-starter-set'), 'savchenko', '8.1.1', 17, 'Current basics'),
  ((SELECT id FROM study_paths WHERE slug='savchenko-starter-set'), 'savchenko', '9.1.1', 18, 'Magnetic field induction'),
  ((SELECT id FROM study_paths WHERE slug='savchenko-starter-set'), 'savchenko', '13.1.1', 19, 'Light propagation'),
  ((SELECT id FROM study_paths WHERE slug='savchenko-starter-set'), 'savchenko', '14.1.1', 20, 'Speed of light constancy');

-- 2. Mechanics Mastery (30 problems, chapters 1-2)
INSERT INTO path_problems (path_id, problem_type, problem_ref, sort_order, notes) VALUES
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '1.1.1', 1, 'Start simple'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '1.1.5', 2, 'Speed and distance'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '1.1.10', 3, 'Relative motion'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '1.2.3', 4, 'Acceleration problems'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '1.2.10', 5, 'Graphical analysis'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '1.3.1', 6, 'Projectile motion'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '1.3.10', 7, 'Curvilinear trajectories'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '1.3.20', 8, 'Advanced projectiles'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '1.4.5', 9, 'Galileo''s transformations'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '1.5.5', 10, 'Constrained motion'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '2.1.1', 11, 'Newton''s first law'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '2.1.5', 12, 'Free body diagrams'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '2.1.15', 13, 'Friction problems'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '2.1.25', 14, 'Multi-body systems'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '2.2.5', 15, 'Momentum'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '2.2.15', 16, 'Center of mass'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '2.2.30', 17, 'Rocket equation'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '2.3.5', 18, 'Kinetic energy'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '2.3.20', 19, 'Potential energy'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '2.3.35', 20, 'Energy conservation'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '2.4.10', 21, 'Power and efficiency'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '2.4.30', 22, 'Energy transfer'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '2.5.5', 23, 'Elastic collisions'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '2.5.20', 24, 'Inelastic collisions'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '2.6.5', 25, 'Gravitational force'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '2.6.20', 26, 'Kepler''s laws'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '2.6.40', 27, 'Orbital mechanics'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '2.7.10', 28, 'Rotational dynamics'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '2.7.30', 29, 'Angular momentum'),
  ((SELECT id FROM study_paths WHERE slug='mechanics-mastery'), 'savchenko', '2.8.20', 30, 'Statics challenge');

-- 3. IPhO Preparation: Thermodynamics (25 problems from ch.5)
INSERT INTO path_problems (path_id, problem_type, problem_ref, sort_order, notes) VALUES
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.1.1', 1, 'Thermal motion basics'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.1.5', 2, 'Brownian motion'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.2.5', 3, 'Maxwell distribution'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.2.10', 4, 'Mean free path'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.3.5', 5, 'Transport phenomena'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.4.5', 6, 'Rare gas behavior'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.5.1', 7, 'Ideal gas law'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.5.10', 8, 'Gas mixtures'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.5.20', 9, 'Atmospheric processes'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.6.1', 10, 'First law basics'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.6.10', 11, 'Heat capacity'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.6.20', 12, 'Adiabatic processes'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.7.1', 13, 'Gas flow'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.7.5', 14, 'Nozzle problems'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.8.5', 15, 'Statistical mechanics'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.8.10', 16, 'Entropy'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.9.1', 17, 'Second law basics'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.9.10', 18, 'Carnot cycle'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.9.20', 19, 'Efficiency and heat engines'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.10.1', 20, 'Phase diagrams'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.10.10', 21, 'Clausius-Clapeyron'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.10.20', 22, 'Latent heat problems'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.10.30', 23, 'Triple point and beyond'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.11.5', 24, 'Stefan-Boltzmann law'),
  ((SELECT id FROM study_paths WHERE slug='ipho-prep-thermodynamics'), 'savchenko', '5.11.15', 25, 'Wien''s law and Planck');

-- 4. From Zero to National Olympiad (50 problems across all topics)
INSERT INTO path_problems (path_id, problem_type, problem_ref, sort_order, notes) VALUES
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '1.1.1', 1, 'Start here: uniform motion'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '1.1.5', 2, 'Speed problems'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '1.2.1', 3, 'Acceleration'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '1.2.10', 4, 'Graphical kinematics'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '1.3.5', 5, 'Projectile motion'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '1.3.15', 6, 'Circular motion'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '2.1.1', 7, 'Newton''s laws'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '2.1.10', 8, 'Multi-body dynamics'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '2.1.30', 9, 'Pulleys and constraints'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '2.2.10', 10, 'Momentum conservation'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '2.3.10', 11, 'Energy methods'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '2.4.15', 12, 'Power'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '2.5.10', 13, 'Collisions'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '2.6.10', 14, 'Gravity'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '2.7.15', 15, 'Rotational motion'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '2.8.10', 16, 'Equilibrium'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '3.2.5', 17, 'Oscillation period'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '3.3.10', 18, 'SHM problems'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '3.5.10', 19, 'Damped oscillations'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '3.6.5', 20, 'Wave speed'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '4.1.5', 21, 'Hydrostatics'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '4.2.10', 22, 'Buoyancy'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '4.3.5', 23, 'Bernoulli equation'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '4.5.5', 24, 'Surface tension'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '5.5.5', 25, 'Ideal gas'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '5.6.5', 26, 'First law'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '5.9.5', 27, 'Second law'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '5.10.5', 28, 'Phase transitions'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '6.1.5', 29, 'Electric field'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '6.2.5', 30, 'Gauss''s theorem'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '6.3.10', 31, 'Potential'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '6.4.5', 32, 'Capacitors'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '6.5.10', 33, 'Electric energy'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '7.1.10', 34, 'Particle in E-field'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '7.4.10', 35, 'Coulomb interactions'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '8.2.10', 36, 'Resistance circuits'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '8.3.15', 37, 'Kirchhoff''s laws'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '9.1.5', 38, 'Magnetic field'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '9.2.10', 39, 'Biot-Savart'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '10.1.10', 40, 'Lorentz force'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '11.1.10', 41, 'EMF induction'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '11.3.10', 42, 'Inductance'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '11.4.10', 43, 'AC circuits'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '12.1.10', 44, 'EM waves'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '13.1.5', 45, 'Geometric optics'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '13.2.10', 46, 'Refraction and lenses'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '13.3.10', 47, 'Optical systems'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '13.4.10', 48, 'Photometry'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '14.1.10', 49, 'Special relativity'),
  ((SELECT id FROM study_paths WHERE slug='zero-to-national'), 'savchenko', '14.5.10', 50, 'Relativistic dynamics');

-- 5. The Hardest Savchenko Problems (20 notoriously difficult)
INSERT INTO path_problems (path_id, problem_type, problem_ref, sort_order, notes) VALUES
  ((SELECT id FROM study_paths WHERE slug='hardest-savchenko'), 'savchenko', '1.3.30', 1, 'Complex projectile with constraints'),
  ((SELECT id FROM study_paths WHERE slug='hardest-savchenko'), 'savchenko', '1.5.20', 2, 'Tricky constrained motion'),
  ((SELECT id FROM study_paths WHERE slug='hardest-savchenko'), 'savchenko', '2.4.44', 3, 'The most edited problem on the site'),
  ((SELECT id FROM study_paths WHERE slug='hardest-savchenko'), 'savchenko', '2.5.39', 4, 'Extreme collision problem'),
  ((SELECT id FROM study_paths WHERE slug='hardest-savchenko'), 'savchenko', '2.6.50', 5, 'Advanced orbital mechanics'),
  ((SELECT id FROM study_paths WHERE slug='hardest-savchenko'), 'savchenko', '2.7.45', 6, 'Rotational dynamics challenge'),
  ((SELECT id FROM study_paths WHERE slug='hardest-savchenko'), 'savchenko', '2.8.40', 7, 'Complex statics'),
  ((SELECT id FROM study_paths WHERE slug='hardest-savchenko'), 'savchenko', '3.5.40', 8, 'Forced oscillations at the limit'),
  ((SELECT id FROM study_paths WHERE slug='hardest-savchenko'), 'savchenko', '5.6.30', 9, 'Non-trivial thermodynamic cycle'),
  ((SELECT id FROM study_paths WHERE slug='hardest-savchenko'), 'savchenko', '5.9.25', 10, 'Second law subtlety'),
  ((SELECT id FROM study_paths WHERE slug='hardest-savchenko'), 'savchenko', '6.3.40', 11, 'Complex conductor geometry'),
  ((SELECT id FROM study_paths WHERE slug='hardest-savchenko'), 'savchenko', '6.5.30', 12, 'Electric field energy'),
  ((SELECT id FROM study_paths WHERE slug='hardest-savchenko'), 'savchenko', '7.4.35', 13, 'Many-particle electrostatics'),
  ((SELECT id FROM study_paths WHERE slug='hardest-savchenko'), 'savchenko', '8.3.45', 14, 'Complex circuit analysis'),
  ((SELECT id FROM study_paths WHERE slug='hardest-savchenko'), 'savchenko', '9.3.20', 15, 'Distributed current magnetic field'),
  ((SELECT id FROM study_paths WHERE slug='hardest-savchenko'), 'savchenko', '11.5.25', 16, 'Superconductor in magnetic field'),
  ((SELECT id FROM study_paths WHERE slug='hardest-savchenko'), 'savchenko', '12.1.30', 17, 'EM wave boundary problem'),
  ((SELECT id FROM study_paths WHERE slug='hardest-savchenko'), 'savchenko', '13.3.25', 18, 'Multi-lens optical system'),
  ((SELECT id FROM study_paths WHERE slug='hardest-savchenko'), 'savchenko', '14.3.25', 19, 'Relativistic field transformation'),
  ((SELECT id FROM study_paths WHERE slug='hardest-savchenko'), 'savchenko', '14.5.24', 20, 'Relativistic energy-momentum');

-- Seed one sample challenge
INSERT INTO challenges (title, problem_statement, difficulty, week_start, week_end, is_active, created_by)
VALUES (
  'Launching into Orbit',
  'A satellite of mass $m$ is launched vertically from the surface of the Earth (radius $R$, mass $M$). At what minimum speed must it be launched so that it enters a circular orbit at height $h = R$ above the surface? Express your answer in terms of $G$, $M$, $R$.',
  7,
  '2026-04-07',
  '2026-04-13',
  true,
  28
);
