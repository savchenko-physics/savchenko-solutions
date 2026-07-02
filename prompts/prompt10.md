# Prompt 10: Physics Tools

ultrathink

Read CLAUDE.md first. Then read prompts/database_structure.txt.

Build a /tools/ section with free physics utilities that students bookmark and use daily. These pages will rank for high-volume queries like "physics formula sheet" and "physics unit converter."

## Task 1: Tools Router + Landing Page

Create tools.js Express router. Mount at /tools in index.js.

GET /tools — landing page listing all tools:
- Title: "Physics Tools" (28px)
- Subtitle: "Free utilities for physics students and olympiad preparation"
- Grid of tool cards (3 columns desktop, 1 mobile), each with: icon, name, one-line description, link
- Add "Tools" to footer quick links

Template: views/tools/index.ejs

## Task 2: Interactive Formula Sheet (/tools/formulas)

Template: views/tools/formulas.ejs

Build a searchable, interactive formula sheet covering all physics topics in the Savchenko textbook. NOT a PDF — a live web page.

Structure by chapter (matching Savchenko chapters):
1. Kinematics
2. Dynamics
3. Oscillations & Waves
4. Fluid Mechanics
5. Molecular Physics & Thermodynamics
6. Electrostatics
7. Charged Particle Motion
8. Electric Current
9. Magnetic Field
10. Complex Fields
11. Electromagnetic Induction
12. EM Waves
13. Optics & Photometry
14. Special Relativity

For each chapter, list 10-20 key formulas with:
- Formula name
- LaTeX-rendered equation (MathJax)
- Brief description of variables
- Collapsible "derivation" section (click to expand)

Features:
- Search bar at top: type "kinetic energy" and it filters to show only matching formulas
- Client-side filtering (all formulas loaded on page, JS filters by search query)
- Sticky chapter navigation sidebar on desktop
- Print-friendly CSS (@media print: hide search, sidebar, expand all formulas)

SEO: title "Physics Formula Sheet — All Formulas for Olympiad Preparation | Savchenko Solutions"

This is the single highest-traffic potential tool. "Physics formula sheet" gets 100k+ monthly searches.

## Task 3: Unit Converter (/tools/units)

Template: views/tools/units.ejs

Physics-specific unit converter with categories:
- Length (m, cm, mm, km, mi, ft, in, Å, nm, μm, light-year, parsec, AU)
- Mass (kg, g, mg, lb, oz, u, eV/c², solar mass)
- Time (s, ms, μs, ns, min, hr, day, year)
- Energy (J, kJ, eV, keV, MeV, GeV, cal, kcal, erg, kWh, Btu)
- Force (N, dyn, lbf, kgf)
- Pressure (Pa, kPa, MPa, atm, bar, mmHg, torr, psi)
- Temperature (K, °C, °F, °R)
- Electric (V, A, Ω, C, F, H, T, Wb)
- Velocity (m/s, km/h, mph, ft/s, knots, c)

Implementation:
- Two dropdowns (from unit, to unit) + input field + output field
- Real-time conversion as user types (no submit button)
- All conversion factors hardcoded in a JS object (no API calls)
- "Swap" button to flip from/to
- Show the conversion formula below: "1 eV = 1.602 × 10⁻¹⁹ J"
- Category tabs at the top

Keep it fast: vanilla JS, no libraries, instant response.

## Task 4: Physical Constants Reference (/tools/constants)

Template: views/tools/constants.ejs

Table of CODATA 2018 physical constants:
- Speed of light, Planck constant, Boltzmann constant, gravitational constant, electron mass, proton mass, elementary charge, permittivity, permeability, Avogadro, gas constant, Stefan-Boltzmann, fine structure constant, Bohr radius, Rydberg constant, etc. (at least 40 constants)
- Columns: Name, Symbol (LaTeX), Value, Unit, Relative uncertainty
- Search/filter bar
- Click any row: copy value to clipboard (show "Copied!" toast)
- Toggle between SI and CGS units

## Task 5: LaTeX Equation Editor (/tools/latex)

Template: views/tools/latex.ejs

- Input textarea for LaTeX
- Live preview panel (MathJax rendered)
- Template buttons for common physics expressions: fraction, square root, integral, summation, vector, partial derivative, matrix
- Physics-specific templates: Newton's second law, Schrödinger equation, Maxwell's equations, Lorentz force
- "Copy LaTeX" button (copies raw LaTeX to clipboard)
- "Copy as Image" button (renders to canvas, copies PNG to clipboard using html2canvas or similar)

## Task 6: SEO for All Tools

Each tool page needs:
- Unique title tag targeting specific queries
- Meta description
- JSON-LD WebApplication schema
- Canonical URL

formulas: "Physics Formula Sheet — Complete Reference for Olympiad Preparation"
units: "Physics Unit Converter — Convert Between SI, CGS, and More"
constants: "Physical Constants Table — CODATA Values with Copy to Clipboard"
latex: "LaTeX Equation Editor — Write Physics Equations with Live Preview"

Verify: all 5 pages render, formula search works, unit converter converts correctly, constants copy to clipboard, LaTeX editor previews live. Navigation links work from /tools landing page.
