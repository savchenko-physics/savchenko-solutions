-- Migration 022: Replace backtick-wrapped usernames with hyperlinks in chain reaction blog post
-- All `username` references become [username](https://savchenkosolutions.com/user/username)

BEGIN;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT old_val, new_val FROM (VALUES
      -- Main contributors (appear in body text + acknowledgments)
      ('`emixter`',           '[emixter](https://savchenkosolutions.com/user/emixter)'),
      ('`astrosander`',       '[astrosander](https://savchenkosolutions.com/user/astrosander)'),
      ('`igor`',              '[igor](https://savchenkosolutions.com/user/igor)'),
      ('`Picksell Prod`',     '[Picksell Prod](https://savchenkosolutions.com/user/Picksell%20Prod)'),
      ('`Ismail`',            '[Ismail](https://savchenkosolutions.com/user/Ismail)'),
      ('`jzmicer`',           '[jzmicer](https://savchenkosolutions.com/user/jzmicer)'),
      ('`Valentao`',          '[Valentao](https://savchenkosolutions.com/user/Valentao)'),
      ('`Julius de Rojas`',   '[Julius de Rojas](https://savchenkosolutions.com/user/Julius%20de%20Rojas)'),
      ('`Sergey_Kuleshov`',   '[Sergey_Kuleshov](https://savchenkosolutions.com/user/Sergey_Kuleshov)'),
      ('`differ4ik`',         '[differ4ik](https://savchenkosolutions.com/user/differ4ik)'),
      ('`AZ_21`',             '[AZ_21](https://savchenkosolutions.com/user/AZ_21)'),
      ('`Arman`',             '[Arman](https://savchenkosolutions.com/user/Arman)'),
      ('`Nurbaqyt`',          '[Nurbaqyt](https://savchenkosolutions.com/user/Nurbaqyt)'),
      ('`crico`',             '[crico](https://savchenkosolutions.com/user/crico)'),
      ('`owais`',             '[owais](https://savchenkosolutions.com/user/owais)'),
      ('`Daniil`',            '[Daniil](https://savchenkosolutions.com/user/Daniil)'),
      ('`heisei`',            '[heisei](https://savchenkosolutions.com/user/heisei)'),
      ('`maxi-baldiviezo`',   '[maxi-baldiviezo](https://savchenkosolutions.com/user/maxi-baldiviezo)'),
      ('`Artem`',             '[Artem](https://savchenkosolutions.com/user/Artem)'),

      -- Acknowledgments section contributors
      ('`Pandemotor`',        '[Pandemotor](https://savchenkosolutions.com/user/Pandemotor)'),
      ('`ssstepa`',           '[ssstepa](https://savchenkosolutions.com/user/ssstepa)'),
      ('`Shrodinger_cat`',    '[Shrodinger_cat](https://savchenkosolutions.com/user/Shrodinger_cat)'),
      ('`Clerk Maxwell`',     '[Clerk Maxwell](https://savchenkosolutions.com/user/Clerk%20Maxwell)'),
      ('`Sasha`',             '[Sasha](https://savchenkosolutions.com/user/Sasha)'),
      ('`Roberto`',           '[Roberto](https://savchenkosolutions.com/user/Roberto)'),
      ('`paul.tichisanu`',    '[paul.tichisanu](https://savchenkosolutions.com/user/paul.tichisanu)'),
      ('`JustABeast`',        '[JustABeast](https://savchenkosolutions.com/user/JustABeast)'),
      ('`Artoghrul`',         '[Artoghrul](https://savchenkosolutions.com/user/Artoghrul)'),
      ('`Teymur`',            '[Teymur](https://savchenkosolutions.com/user/Teymur)'),
      ('`ibrahim`',           '[ibrahim](https://savchenkosolutions.com/user/ibrahim)'),
      ('`Meryem Abushova`',   '[Meryem Abushova](https://savchenkosolutions.com/user/Meryem%20Abushova)'),
      ('`Quorixis`',          '[Quorixis](https://savchenkosolutions.com/user/Quorixis)'),
      ('`I_HALIMOV`',         '[I_HALIMOV](https://savchenkosolutions.com/user/I_HALIMOV)'),
      ('`giorgiotinashvili`', '[giorgiotinashvili](https://savchenkosolutions.com/user/giorgiotinashvili)'),
      ('`ar4senN`',           '[ar4senN](https://savchenkosolutions.com/user/ar4senN)'),
      ('`Nurbek`',            '[Nurbek](https://savchenkosolutions.com/user/Nurbek)'),
      ('`Maqsat`',            '[Maqsat](https://savchenkosolutions.com/user/Maqsat)'),
      ('`Islambek`',          '[Islambek](https://savchenkosolutions.com/user/Islambek)'),
      ('`Temirlan`',          '[Temirlan](https://savchenkosolutions.com/user/Temirlan)'),
      ('`Zhanseiit`',         '[Zhanseiit](https://savchenkosolutions.com/user/Zhanseiit)'),
      ('`Rostyslav`',         '[Rostyslav](https://savchenkosolutions.com/user/Rostyslav)'),
      ('`bandemort`',         '[bandemort](https://savchenkosolutions.com/user/bandemort)'),
      ('`motorchik_228`',     '[motorchik_228](https://savchenkosolutions.com/user/motorchik_228)'),
      ('`zholtik`',           '[zholtik](https://savchenkosolutions.com/user/zholtik)'),
      ('`naz`',               '[naz](https://savchenkosolutions.com/user/naz)'),
      ('`Yarocrafter`',       '[Yarocrafter](https://savchenkosolutions.com/user/Yarocrafter)'),
      ('`priusfox`',          '[priusfox](https://savchenkosolutions.com/user/priusfox)'),
      ('`fcubsovv`',          '[fcubsovv](https://savchenkosolutions.com/user/fcubsovv)'),
      ('`Maxim`',             '[Maxim](https://savchenkosolutions.com/user/Maxim)'),
      ('`RozhnovMV`',         '[RozhnovMV](https://savchenkosolutions.com/user/RozhnovMV)'),
      ('`bbush`',             '[bbush](https://savchenkosolutions.com/user/bbush)'),
      ('`AW3Rgo0l`',          '[AW3Rgo0l](https://savchenkosolutions.com/user/AW3Rgo0l)'),
      ('`Spiral`',            '[Spiral](https://savchenkosolutions.com/user/Spiral)'),
      ('`KerQwe`',            '[KerQwe](https://savchenkosolutions.com/user/KerQwe)'),
      ('`Dostonbek`',         '[Dostonbek](https://savchenkosolutions.com/user/Dostonbek)'),
      ('`IVA`',               '[IVA](https://savchenkosolutions.com/user/IVA)'),
      ('`shaposhnik daniil`', '[shaposhnik daniil](https://savchenkosolutions.com/user/shaposhnik%20daniil)'),
      ('`Buchander`',         '[Buchander](https://savchenkosolutions.com/user/Buchander)'),
      ('`the_raspberrygirl`', '[the_raspberrygirl](https://savchenkosolutions.com/user/the_raspberrygirl)'),
      ('`LyubitelFiziki`',    '[LyubitelFiziki](https://savchenkosolutions.com/user/LyubitelFiziki)'),
      ('`Artemij_Chess`',     '[Artemij_Chess](https://savchenkosolutions.com/user/Artemij_Chess)'),
      ('`nikuluna.arina.s07`','[nikuluna.arina.s07](https://savchenkosolutions.com/user/nikuluna.arina.s07)'),
      ('`Marcus`',            '[Marcus](https://savchenkosolutions.com/user/Marcus)'),
      ('`Xolbek`',            '[Xolbek](https://savchenkosolutions.com/user/Xolbek)'),
      ('`Azizbek`',           '[Azizbek](https://savchenkosolutions.com/user/Azizbek)'),
      ('`ogWlean`',           '[ogWlean](https://savchenkosolutions.com/user/ogWlean)'),
      ('`muhammadazizmakhsutaliyev`', '[muhammadazizmakhsutaliyev](https://savchenkosolutions.com/user/muhammadazizmakhsutaliyev)'),
      ('`kriukov`',           '[kriukov](https://savchenkosolutions.com/user/kriukov)'),
      ('`Jorge Llorente 08`', '[Jorge Llorente 08](https://savchenkosolutions.com/user/Jorge%20Llorente%2008)'),
      ('`Nolemacil`',         '[Nolemacil](https://savchenkosolutions.com/user/Nolemacil)'),

      -- Website name → link to site
      ('`savchenkosolutions.com`', '[savchenkosolutions.com](https://savchenkosolutions.com)')
    ) AS t(old_val, new_val)
  LOOP
    UPDATE blog_posts
    SET content = REPLACE(content, r.old_val, r.new_val)
    WHERE slug = 'tsepnaya-reaktsiya-ili-radioaktivnyy-raspad';
  END LOOP;
END $$;

COMMIT;
