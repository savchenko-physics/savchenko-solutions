-- 013_weekly_challenge_kvant_2850.sql
-- New weekly challenge from Kvant magazine 2025 No.5-6
-- Problem F2850 from LVIII Russian Physics Olympiad (final stage)

-- Deactivate previous challenges
UPDATE challenges SET is_active = false WHERE is_active = true;

-- Insert new weekly challenge
INSERT INTO challenges (title, problem_statement, solution, difficulty, week_start, week_end, is_active, created_by)
VALUES (
  'Two Stones from a Tower (Kvant F2850)',
  'С вершины башни высотой $h$ с одинаковыми скоростями, равными $v$, и направленными перпендикулярно одна к другой, под разными углами к горизонту одновременно брошены два камня так, что их движение происходит в одной вертикальной плоскости. Через некоторое время после броска, как раз непосредственно перед падением одного камня на землю, оказалось, что векторы скоростей камней направлены под одинаковыми углами к горизонту.

Определите величину этого угла $\varphi$ и расстояние между камнями $l$ в этот момент времени.

Известно, что в начальный момент времени оба камня удаляются от поверхности земли, а непосредственно перед падением одного камня на землю другой камень тоже приближается к поверхности земли. Башня расположена на горизонтальной поверхности. Ускорение свободного падения равно $g$. Сопротивление воздуха не учитывайте.

---

From the top of a tower of height $h$, two stones are thrown simultaneously with equal speeds $v$, directed perpendicular to each other, at different angles to the horizontal, so that their motion occurs in the same vertical plane. After some time, just before one of the stones hits the ground, the velocity vectors of both stones turn out to be directed at equal angles to the horizontal.

Determine the angle $\varphi$ and the distance $l$ between the stones at that moment.

It is known that at the initial moment both stones are moving away from the surface, and just before one stone hits the ground the other is also approaching the surface. The tower stands on a horizontal surface. The free-fall acceleration is $g$. Neglect air resistance.

*Source: Kvant magazine 2025 No.5-6, problem F2850 (LVIII Russian Physics Olympiad, final stage). Author: A. Apolonsky.*',
  NULL,
  8,
  '2026-05-12',
  '2026-05-18',
  true,
  28
);
