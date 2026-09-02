# English statement corrections proposed by scripts/book3/fix-en.py

58 accepted, 254 rejected. Each entry: the flagged issue, then a word diff (old → new).

## 2.2.3
- issue: The symbol for momentum is changed from 'p' to '$\rho$' (rho), and the phrase 'modulo' is a mistranslation of 'по модулю' (in magnitude) placed incorrectly before the symbol.
- judge: The NEW version correctly translates 'по модулю импульсом p' as 'magnitude of momentum $p$', fixing the OLD version's incorrect symbol ($\rho$ instead of $p$) and awkward phrasing ('momentum modulo').
- diff: + magnitude + of + $p$ - modulo - $\rho$

## 2.2.15
- issue: Symbol mismatch: English uses rho ($\rho$) instead of p for momentum variables.
- judge: The NEW version correctly uses the symbol 'p' for momenta as in the Russian original, whereas the OLD version incorrectly used the Greek letter 'ρ'.
- diff: - $\rho_1$ + $p_1$ - $\rho_2$, + $p_2$,

## 2.2.32
- issue: English incorrectly states that the masses M are jumping, whereas Russian states that N balls jump under a piston of mass M.
- issue: English interprets 'N 1' as 'N >> 1' (much greater than), but the Russian text literally reads 'N 1' which may imply N=1 or is a formatting error; the relation symbol is missing in the source.
- judge: The NEW version correctly assigns mass M to the piston and fixes the typo in the condition for N, whereas the OLD version incorrectly stated that the masses M were jumping.
- diff: - piston, + piston + of - masses + mass - $M$ + $M$, + $N$ + balls + of + mass + $m$ + each - cylinder, + cylinder. - $N$ - balls - of - mass - $m$ - each. - \gg + \

## 2.4.42
- issue: Incorrect subscript: English has B_omega instead of B multiplied by omega.
- issue: Inequality condition changed from greater-than-or-equal to strictly greater-than.
- issue: Physical quantity error: English compares weight to mass, Russian compares mass to mass.
- judge: The NEW version correctly fixes the formula typo (B_ω to Bω), the inequality sign (> to ≥), and the physical term error ('weight' to 'mass'), making it strictly closer to the Russian original.
- diff: - B_{\omega})\omega$, + B\omega)\omega$, - > + \geqslant - weight + mass

## 2.7.33
- issue: The English translation inserts 'is' creating an equality ($m_2 = m_1$), whereas the Russian text 'm2 m1' in this context (given the explicit instruction to ignore notation format but report missing symbols/conditions) almost certainly represents the inequality $m_2 \ll m_1$ (bullet mass much less than cylinder mass) with the 'less than' symbols lost or flattened, which is a standard condition for such problems to simplify the moment of inertia calculation.
- judge: The NEW version correctly translates the Russian condition 'm2 m1' (implying m2 is much less than m1) as '$m_2 \ll m_1$', whereas the OLD version incorrectly stated '$m_2$ is $m_1$'.
- diff: - $m_2$ + $m_2 - is + \ll - $m_1$, + m_1$,

## 2.8.12
- issue: Mistranslation of 'раствор' (opening/gap) as 'solution' changes the physical meaning.
- issue: OCR error interpreted the symbol 'αмин' (alpha_min) as the chemical word 'amine', losing the variable definition.
- judge: The NEW version correctly translates 'угол раствора' as 'opening angle' instead of the nonsensical 'solution' and preserves the original symbol 'αмин' instead of mistranslating it as 'amine'.
- diff: + opening - solution - amine + αмин

## 2.8.21
- issue: Subscript error: '2_L' in English vs '2L' (2 times L) in Russian.
- judge: The NEW version corrects the typo '$2_L$' to '$2L$', matching the Russian original's '2L', while preserving all other details.
- diff: - $2_L$, + $2L$,

## 2.8.34
- issue: Wrong physical object: 'staircase' (a structure) instead of 'ladder' (a rigid body).
- issue: Wrong symbol: 'm' usually denotes mass, while the Russian text uses 'm' to represent the friction coefficient (typically denoted by $\mu$), creating a conflict with standard physics notation.
- judge: The NEW version correctly translates 'Лестница' as 'ladder' instead of 'staircase' and uses the standard physics symbol '$\mu$' for friction coefficients instead of '$m$', aligning strictly with the original meaning and conventions.
- diff: - staircase + ladder - $m_1$ + $\mu_1$ - $m_2$, + $\mu_2$,

## 3.1.3
- issue: OCR failure in English text rendered the formula as garbled text 'v p1' and missing subscripts 'x/x', whereas the Russian original implies the correct formula v = v_0 * sqrt(1 - (x/x_0)^2) which the English translation attempts to fix but the source OCR string is defective.
- issue: The English phrasing 'relation between... and... and...' ambiguously suggests a relationship between three variables, whereas the Russian 'зависимость ... от ...' clearly requests two separate dependencies: Force(x) and Potential Energy(x).
- judge: The NEW version correctly translates 'зависимость... от' as 'dependence... on' and 'полученный результат' as 'obtained result', fixing semantic errors in the OLD version while preserving all other details.
- diff: - relation - between + dependence + of - the + this - and + on + obtained - above + given

## 3.3.4
- issue: Physics error: In Russian physics terminology, 'Частота' with symbol ω denotes angular frequency, whereas English 'frequency' typically denotes cyclic frequency (ν or f), creating a factor of 2π discrepancy.
- issue: Grammatical error altering meaning: The phrase 'In what is' is nonsensical and breaks the question structure compared to 'In what shortest time' or 'After what shortest time'.
- judge: The NEW version correctly identifies ω as angular frequency and fixes the ungrammatical phrasing 'In what is' to 'After what... does', aligning strictly with the Russian original's meaning and grammar.
- diff: + angular - In + After - is - the + does - decreases + decrease

## 3.5.21
- issue: The Russian text '108−109' represents the range 10^8 to 10^9 (contextual exponent notation), whereas the English translation '10^8 - 10^9' mathematically denotes the subtraction of 10^9 from 10^8, changing the physical value from a large range to a negative number.
- judge: The NEW version correctly formats the range '10^8--10^9' to match the Russian original's '108−109', whereas the OLD version incorrectly used a hyphen with spaces.
- diff: + 10^8\text{--}10^9$ - 10^8 - - - 10^9$

## 3.6.20
- issue: The Russian text 'ε 1' (likely meaning ε₁ or a specific value ε₁) was misinterpreted as the inequality 'ε ≪ 1' (epsilon much less than 1), changing a parameter definition into a physical condition.
- judge: The NEW version correctly translates the specific symbol '$\varepsilon_1$' from the Russian original, whereas the OLD version incorrectly changed it to '$\varepsilon \ll 1$'.
- diff: - $\varepsilon + $\varepsilon_1$ - \ll - 1$

## 3.7.21
- issue: The speed variable is incorrectly translated as nu ($\nu$) instead of v, conflicting with the frequency symbol.
- judge: The NEW version correctly uses the symbol $v$ for speed, matching the Russian original, whereas the OLD version incorrectly used $
u$.
- diff: - $\nu$? + $v$?

## 3.9.6
- issue: English adds condition 'omega >> c/L' which is absent in Russian; Russian only defines frequency as 'omega c/L'.
- issue: English adds condition 'omega << c/L' which is absent in Russian; Russian text 'ω c/L' lacks an inequality operator.
- judge: The NEW version correctly translates the frequency expression and condition from the Russian original, whereas the OLD version incorrectly inserted inequality symbols (>> and <<) that are absent in the source text.
- diff: - . + c/L$, - \gg - \frac{c}{L}$, + c/L$? - \ll - \frac{c}{L}$?

## 4.2.10
- issue: Wrong physical quantity (weight instead of mass) and wrong unit symbol ('r' instead of 'g' for grams).
- judge: The NEW version correctly translates 'Масса' as 'mass' and 'г' as 'g', whereas the OLD version incorrectly used 'weight' and 'r'.
- diff: - weight + mass - $r$. + $g$.

## 4.6.13
- issue: The Russian text specifies the angle is '1 rad' (or potentially missing a symbol before 1), while the English text changes this to the condition '$\alpha \ll 1$' (much less than 1), which fundamentally alters the physical approximation required for the solution.
- judge: The NEW version correctly translates the Russian 'α 1 рад' as an equality (α = 1 rad), whereas the OLD version incorrectly interprets it as a small-angle approximation (α ≪ 1 rad).
- diff: - \ll + =

## 5.2.1
- issue: The exponent 10^12 in the Russian text (implied by context and standard notation 1012 for 10^12 in flattened text) is rendered as the number 1012 in English, changing the value by orders of magnitude.
- judge: The NEW version corrects the typo '1012' to '10^{12}' to match the Russian original's '1012' (interpreted as 10^12 in context), while preserving all other content exactly.
- diff: - 1012$. + 10^{12}$.

## 5.3.6
- issue: The symbol '$\div$' incorrectly replaces the word 'part' (or fraction), altering the meaning from '0.1 part of the atoms' to a nonsensical mathematical operation or typo.
- judge: The NEW version correctly translates '0,1 часть' as '0.1 part', whereas the OLD version incorrectly used '0.1÷' which alters the meaning and includes a stray symbol.
- diff: - 0.1$\div$ + 0.1 + part

## 5.5.20
- issue: The English text translates the density symbol 'ρ' (rho) as the word 'plane' and the letter 'p', altering the physical quantity from density to an undefined geometric concept.
- judge: The NEW version correctly translates 'плотности ρ' as 'density ρ', fixing the OLD version's erroneous 'plane p' while preserving all other details.
- diff: + density + $\rho$ - the - plane - p

## 5.8.16
- issue: English states volume increases by factor n, Russian states it increases by factor sqrt(n).
- issue: English asks if temperature decreases by sqrt(n), Russian asks if it decreases by n.
- judge: The NEW version correctly places the square root on the volume expansion factor ($\sqrt{n}$) as implied by the Russian text's 'в√ n раз', whereas the OLD version incorrectly applied it to the phrasing structure rather than the value.
- diff: - $n$ + $\sqrt{n}$ - $\sqrt{n}$ + $n$

## 5.9.13
- issue: The exponent is missing; the Russian text '107' in this context represents 10^7, but the English translation renders it as the integer 107.
- judge: The NEW version corrects the scientific notation formatting from '107' to '10^7', matching the Russian original's intended value of 3.3 · 10^7 J/kg.
- diff: - 107$ + 10^7$

## 5.10.8
- issue: The Russian text '103' represents 10^3 (scientific notation flattened), but the English OCR rendered it as the literal number 103, changing the density by three orders of magnitude.
- judge: The NEW version corrects the density notation from '103' to '10^3', matching the Russian original's scientific notation while preserving all other content.
- diff: - 103$ + 10^3$

## 6.1.7
- issue: Subscript '2' was incorrectly OCR'd as '-2', changing the charge identifier from q_2 to q minus 2.
- judge: The NEW version corrects the typo '$q-2$' to '$q_2$', matching the Russian original, while preserving all other details.
- diff: - $q-2$, + $q_2$,

## 6.1.12
- issue: The Russian text '1016' in the context of atomic physics angular velocity is a flattened representation of 10^16 (10 to the power of 16), whereas the English translation interprets it as the literal number one thousand and sixteen.
- judge: The NEW version correctly interprets the Russian '1016' as a typo for scientific notation $10^{16}$, which is the physically realistic value for this problem, whereas the OLD version literally translates the typo.
- diff: - $1016$ + $10^{16}$

## 6.1.13
- issue: Missing minus sign in the charge value; English reads as 'charge minus q' (hyphen) or ambiguous, whereas Russian explicitly states negative charge '-q'.
- judge: The NEW version correctly translates the charge as '-q' matching the Russian '−q', whereas the OLD version incorrectly omitted the negative sign.
- diff: - charge-$q$ + charge + $-q$

## 6.3.26
- issue: The symbol for volume charge density is incorrectly transcribed as 'p' instead of 'ρ' (rho), which represents a different physical variable.
- judge: The NEW version corrects the typo in the third question where the volume charge density was incorrectly written as '$p$' instead of '$\rho$', matching the Russian original and the previous parts, without making any other changes.
- diff: - $p$, + $\rho$,

## 7.2.4
- issue: The English text presents an incorrect mathematical expression with plus signs between reciprocal terms, whereas the Russian text lists the terms '1/a', '1/b', and '1/f' (implied by the layout) separated by plus signs but missing the equality to zero or the correct lens formula structure ($\frac{1}{a} + \frac{1}{b} = \frac{1}{f}$ or similar); specifically, the English renders it as a sum equal to nothing or implies the formula IS the sum, while the Russian asks to derive the formula involving these terms, likely $\frac{1}{a} + \frac{1}{b} = \frac{1}{f}$ (standard thin lens) or a variation, but the English explicitly writes a nonsensical sum of three reciprocals as the formula itself.
- judge: The NEW version correctly includes the equals sign in the formula, matching the mathematical structure implied by the Russian text, whereas the OLD version incorrectly presented it as a sum without an equation.
- diff: - + + =

## 7.3.15
- issue: The English version adds the condition 'much less than' (<<) which is not present in the Russian text; the Russian likely implies a proportionality or simply lists the parameter.
- judge: The NEW version correctly translates the attenuation coefficient as '$\gamma \omega_0$' matching the Russian original, whereas the OLD version incorrectly changed it to '$\gamma \ll \omega_0$'.
- diff: - \ll

## 8.1.6
- issue: The emission rate symbol is the Greek letter nu (ν) in Russian, but incorrectly transcribed as the Latin letter v in English, causing a collision with the velocity symbol v used later in the sentence.
- judge: The NEW version correctly uses the symbol $\nu$ for the emission rate, matching the Russian original, whereas the OLD version incorrectly used $v$ which conflicts with the velocity symbol.
- diff: - $v$ + $\nu$

## 8.1.17
- issue: The symbol for charge density is incorrectly transcribed as 'p' instead of 'ρ' (rho), changing the physical quantity.
- judge: The NEW version corrects the typo 'p(x)' to '$\rho$(x)', matching the Russian original's symbol for charge density, while keeping all other content identical.
- diff: - $p$($x$) + $\rho$($x$)

## 8.2.4
- issue: The value '103' in English is likely an OCR error for '10^3' (1000), as 103 rad/s is unusually low for such problems and matches the flattened text pattern '103' meaning 10³ found in the Russian source context.
- issue: The symbol 'π' (pi) in the Russian text is an OCR error for the Cyrillic letter 'τ' (tau) representing time; the English translation incorrectly retains 'pi' instead of correcting it to 'tau' or 't', leading to a physical nonsense statement (time equals pi).
- issue: The English text omits the unit 's' (seconds) after the time value, which is present in the Russian original.
- judge: The NEW version correctly fixes critical typos in the OLD version (interpreting '103' as 10^3, replacing the nonsensical variable 'pi' with 'tau' for time, and correcting the conductivity unit from 'Cm' to 'S'), thereby aligning the meaning with the Russian original while preserving all other details.
- diff: - $Omega + $\Omega - 103$ + 10^3$ - $pi + $\tau + s - $\frac{Cm}{m}$ + $\frac{S}{m}$

## 8.2.15
- issue: The exponent notation '10-8' in the English text is missing the superscript or caret, incorrectly representing the value as 2.83 multiplied by 10 minus 8, rather than 2.83 times 10 to the power of -8.
- judge: The NEW version corrects the mathematical notation of the exponent from '10-8' to '10^{-8}', making it strictly closer to the Russian original's meaning while changing nothing else.
- diff: - 10-8$ + 10^{-8}$

## 8.2.18
- issue: Unit symbol 'Cm' (Coulomb-meter or typo) used instead of 'Sm' or 'S' for Siemens; Russian 'См' stands for Siemens.
- judge: The NEW version correctly translates the unit of conductivity as S/m (Siemens per meter) instead of the incorrect Cm/m in the OLD version, while preserving all other details exactly.
- diff: - $\frac{Cm}{m}$. + $\frac{S}{m}$.

## 8.2.27
- issue: Missing subscript: Russian 'V0' denotes V_0 (initial potential/energy parameter), English renders it as variable V multiplied by 0 or undefined V0.
- judge: The NEW version corrects the subscript notation from '$eV0$' to '$eV_0$', matching the standard mathematical representation implied by the Russian original while preserving all other content.
- diff: - $eV0$. + $eV_0$.

## 9.1.12
- issue: The English translation incorrectly formats the second angle as a fraction with denominator (2-alpha) instead of the difference (pi/2 minus alpha).
- judge: The NEW version correctly translates the Russian expression 'π/2−α' as '\frac{\pi}{2}-\alpha', fixing the OLD version's erroneous '\frac{\pi}{2-\alpha}' which incorrectly places the alpha in the denominator.
- diff: - $\frac{\pi}{2-\alpha}$ + $\frac{\pi}{2}-\alpha$

## 9.4.9
- issue: Missing division operator; English renders the ratio as a product or malformed expression instead of B_0 * x / x_0.
- judge: The NEW version correctly formats the mathematical expression as a division ($B_0 x/x_0$), whereas the OLD version omits the division symbol, altering the meaning.
- diff: - ${B_0 + $B_0 - x}{x_0}$ + x/x_0$

## 10.1.3
- issue: Unit symbol 'Tl' (Thallium) is incorrect; should be 'T' (Tesla).
- judge: The NEW version corrects the unit symbol from 'Tl' to the standard 'T' for Tesla, aligning with the Russian 'Тл' while preserving all other content.
- diff: - Tl. + T.

## 11.3.2
- issue: The English translation incorrectly formats the second angle as a fraction with subtraction in the denominator, whereas the Russian specifies the angle is (π/2) minus α.
- judge: The NEW version correctly fixes the mathematical expression for the second angle from the erroneous '\frac{\pi}{2 - \alpha}' in the OLD version to '\frac{\pi}{2} - \alpha', which accurately reflects the Russian original 'π/2 − α'.
- diff: - $\frac{\pi}{2 + $\frac{\pi}{2} - \alpha}$. + \alpha$.

## 11.3.7
- issue: Wrong unit symbol 'Gn' instead of 'H' (Henry); 'Gn' is not a standard unit for inductance and changes the physical meaning.
- judge: The NEW version correctly translates the inductance unit 'Гн' as 'H' (Henry) instead of the incorrect 'Gn' in the OLD version, while preserving all other details.
- diff: - Gn. + H.

## 11.4.8
- issue: The unit for inductance L is incorrectly translated as 'Hz' (frequency) instead of 'H' (Henry); the Russian 'Гн' (abbreviated here as Гц in the prompt's flattened text context or likely a typo in the prompt's representation of Гн) clearly refers to inductance, while Hz is physically wrong for L.
- issue: The symbol for frequency is translated as Latin 'v' instead of Greek 'ν' (nu), which creates ambiguity with velocity or voltage, though the value 50 Hz confirms it is frequency.
- issue: The Russian text likely contains a typo 'Гц' instead of 'Гн' for Henry, but the English translation blindly copies this error as 'Hz' instead of correcting it to the physical unit 'H' for inductance, making the problem physically nonsensical.
- judge: The NEW version correctly uses the Greek letter nu (ν) for frequency and fixes the unit for inductance from Hz to H, aligning strictly with the Russian original's symbols and physical meaning.
- diff: - $v$? + $\nu$? - $v + $\nu - Hz, + H,

## 11.4.11
- issue: Unit 'Gn' is incorrect; Russian 'Гн' stands for Henry (H), 'Gn' is not a standard unit symbol and changes the physical meaning.
- judge: The NEW version correctly translates the unit 'Гн' as 'H' (Henry) instead of the incorrect 'Gn' in the OLD version, while preserving all other details.
- diff: - Gn, + H,

## 11.4.17
- issue: Wrong unit symbol: 'Gn' instead of 'H' (Henry); 'Gn' is not a valid unit for inductance.
- issue: Wrong symbol: Latin 'v' used instead of Greek nu 'ν' for frequency, which can be confused with velocity.
- judge: The NEW version corrects the unit for inductance from 'Gn' to 'H' and the frequency symbol from 'v' to 'ν', aligning strictly with the Russian original while preserving all other content.
- diff: - Gn. + H. - $v + $\nu

## 11.5.16
- issue: The Russian text 'R l' (likely a typo for 'R >> l' or distinct variables R and l) is interpreted in the English translation as a single subscripted variable 'r_l', altering the physical definition of the solenoid's radius.
- judge: The NEW version correctly interprets the Russian 'R l' as the condition 'R >> l' (radius much greater than length), whereas the OLD version incorrectly transcribed it as a variable 'r_l'.
- diff: - $r_l$, + $R + \gg + l$,

## 11.5.17
- issue: The English translation interprets the relationship between length and radius as 'much greater than' ($\gg$), whereas the Russian text 'l r' (likely a formatting error for $l \ll r$ given the context of a 'short' coil) implies a different or missing relational operator, fundamentally changing the physical approximation of the coil's geometry.
- judge: The NEW version correctly translates the Russian symbol 'l r' (implying l is much less than r) as 'l \ll r', whereas the OLD version incorrectly used 'l \gg r'.
- diff: - \gg + \ll

## 11.5.24
- issue: The English translation inserts a 'much less than' symbol ($\ll$) between h and a, whereas the Russian text only lists the dimensions 'h a, l' without specifying a relationship or inequality.
- issue: The English translates 'Масса' (Mass) as 'weight', which is a different physical quantity (Force vs Mass).
- judge: The NEW version correctly translates 'масса' as 'mass' instead of 'weight' and accurately represents the dimensions list without adding the unintended inequality symbol found in the OLD version.
- diff: + ($h$,$a$,$l$). - ($h - \ll - a$,$l$). - weight + mass

## 11.6.11
- issue: Translation error: 'непроницаемость' in this context is a typo/OCR error in the Russian source for 'проницаемость' (permittivity), but the English translation 'impermeability' creates a physically incorrect quantity; it must be 'permittivity' to match the symbol ε and standard physics.
- judge: The NEW version correctly translates 'диэлектрической проницаемостью' as 'dielectric permittivity', fixing the incorrect term 'dielectric impermeability' in the OLD version while preserving all other details.
- diff: - impermeability + permittivity

## 12.1.14
- issue: The symbol 'd_v' is incorrect; it should be 'dv' (differential of velocity), changing the mathematical meaning.
- issue: The English text incorrectly defines the velocity function with a retarded time argument inside the definition, whereas the Russian defines it as v0 sin(ωt) and applies the retardation only when calculating the field.
- judge: The NEW version correctly translates the example velocity as 'v0 sin ωt' (matching the Russian 'v0 sin ωt'), whereas the OLD version incorrectly stated the velocity itself was 'v0 sin ω(t - x/c)'.
- diff: - $d_v$, + $dv$, + t$ - (t - - - \frac{x}{c})$

## 12.1.15
- issue: Formula structure mismatch: Russian implies v evaluated at (t - x/c) divided by c, English renders subscript as 't - x/c' and divides the whole term by c incorrectly or ambiguously.
- issue: Wrong symbol: English uses Latin 'v' (velocity) instead of Greek 'ν' (nu) for frequency, causing confusion with velocity variables used elsewhere.
- judge: The NEW version correctly translates the Russian symbol for frequency (ν) as LaTeX '$\nu$' instead of the letter 'v', and fixes the formula's retarded time notation to match the Russian source, while preserving all other content.
- diff: - \frac{x}{c}}}{c}) + x/c}}{c}) - $v$. + $\nu$.

## 12.1.18
- issue: The symbol for frequency is the Greek letter nu (ν) in Russian, but the English translation uses the Latin letter 'v', which typically denotes velocity; this is a wrong symbol that changes the physical meaning.
- judge: The NEW version correctly uses the Greek letter nu (ν) for frequency, matching the Russian original, whereas the OLD version incorrectly used the Latin letter v.
- diff: - $v + $\nu

## 12.2.3
- issue: The subscript '3' in the reflection angle is incorrectly rendered as a subtraction operator '-3'.
- judge: The NEW version corrects the typo '$\alpha-3$' to '$\alpha_3$', matching the Russian original, while preserving all other content exactly.
- diff: - \alpha-3$); + \alpha_3$);

## 13.2.5
- issue: Wrong subscript: English uses 'n_a' (diamond) instead of 'n_w' or 'n_b' (water), incorrectly assigning the diamond's refractive index variable to water.
- judge: The NEW version corrects the subscript typo in the water refractive index from '$n_a$' to '$n_b$', aligning it with the Russian original's distinction between diamond ($n_a$) and water ($n_в$).
- diff: - ($n_a + ($n_b

## 13.2.12
- issue: The English text introduces a 'much less than' condition ($h \ll$) and a fraction bar that are not present in the Russian text, which appears to state a limit or condition 'at h n/α' (likely a typo in the source for $h < n/\alpha$ or similar, but definitely not $\ll$).
- judge: The NEW version correctly translates the Russian condition 'h < n/α' as an inequality, whereas the OLD version incorrectly used the approximation symbol '≪'.
- diff: - \ll - \frac{n}{\alpha}$. + < + n/\alpha$.

## 13.5.9
- issue: Translation error: 'шаровой галактики' means 'spherical galaxy', whereas 'globular galaxy' typically refers to a 'globular cluster' (шаровое скопление), changing the physical object described.
- issue: Notation error: 'MS' in English implies M times S, whereas the Russian 'MС' (with Cyrillic С) denotes Solar Mass ($M_\odot$); the English text fails to correctly represent the unit symbol for Solar Mass.
- judge: The NEW version correctly translates 'шаровой' as 'spherical' instead of the inaccurate 'globular' and uses the standard solar mass symbol matching the Russian context.
- diff: - globular + spherical - MS$ + M_\odot$ - $MS$ + $M_\odot$

## 14.2.3
- issue: Wrong particle symbol: English uses 'm' (mass) instead of 'µ' (muon).
- issue: Wrong particle symbol: English uses 'm' (mass) instead of 'µ' (muon).
- issue: Logical inconsistency: The premise describes muons (µ), but the question asks about pions (π), whereas the Russian text consistently refers to muons (likely a typo in the Russian original's question part, but the English translation introduces a conflict by correctly translating the symbol 'π' while the context implies 'µ', or the Russian text itself has a typo 'π' instead of 'µ'. However, strictly comparing the text provided: Russian says 'π-мезонов' in the question. Wait, re-reading Russian: 'скоростью π-мезонов'. The Russian text *itself* switches from µ to π. The English translates this switch faithfully. Is this an error in translation or a faithful translation of a flawed original? The prompt says 'Russian is authoritative'. If the Russian says π, the English must say π. The error is in the 'm' vs 'µ'. The switch from µ to π in the Russian text is likely a typo in the source book, but as an OCR checker, I must treat the Russian as truth. The English correctly translates 'π' as '$\pi$'. The error is ONLY the 'm' vs 'µ'.
- judge: The NEW version correctly translates the Russian symbol 'µ' (mu) as '$\mu$', whereas the OLD version incorrectly used '$m$'; however, both English versions retain the original Russian text's inconsistency of switching from µ-mesons to π-mesons in the final sentence.
- diff: - $m$-meson + $\mu$-meson - $m$-mesons + $\mu$-mesons

## 14.2.14
- issue: Symbol error: English uses Latin 'v' (velocity) instead of Greek 'ν' (nu, frequency), conflicting with the variable 'v' used for speed in the same text.
- issue: Symbol error: English uses Latin 'v' (velocity) instead of Greek 'ν' (nu, frequency).
- judge: The NEW version correctly uses the Greek letter nu (ν) for frequency, matching the Russian original, whereas the OLD version incorrectly used the Latin letter v.
- diff: - $v_1$ + $\nu_1$ - $v_2$. + $\nu_2$. - $v_0$. + $\nu_0$.

## 14.3.5
- issue: English adds a vector arrow to beta_1 which is absent in the Russian text; Russian uses tilde (~) likely denoting approximation or specific notation, not vectorization.
- issue: English adds a vector arrow to beta on the RHS which is absent in the Russian text; Russian uses tilde (~) instead.
- judge: The NEW version correctly translates the tilde notation (~) from the Russian original, whereas the OLD version incorrectly changed it to vector arrows.
- diff: - $\overrightarrow{\beta}_1 + $\tilde{\beta}_1 - \overrightarrow{\beta}$. + \tilde{\beta}$.

## 14.3.28
- issue: The symbol 'β' (beta) representing the velocity fraction is missing or corrupted to 'of', changing the physical condition from a variable speed βc to a nonsensical string.
- judge: The NEW version correctly translates the speed as '$\beta c$' matching the Russian '$\beta c$', whereas the OLD version contains a typo ('ofcc').
- diff: - ofcc. + of + $\beta + c$.

## 14.5.18
- issue: The reaction equation uses a minus sign '-' instead of a plus sign '+' between the electron and positron ($e^+ + e^-$), incorrectly implying subtraction rather than collision.
- judge: The NEW version corrects the reaction equation symbol from '-' to '+', matching the Russian original's physical meaning while preserving all other text and numbers.
- diff: - - + +
