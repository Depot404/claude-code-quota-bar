# Exposition d'authentification — audit du 2026-08-25

**Objet.** Cartographier exactement ce que l'extension « Claude Convs » lit comme éléments
d'authentification, par quel code, et ce qui sort de la machine — puis confronter cet état au
texte d'Anthropic sur l'usage des identifiants, et poser les options possibles.

**Ce document ne décide rien et ne modifie aucun code.** Il constate et chiffre. La décision
appartient à l'utilisateur.

> ## ⬛ Décision — 2026-08-25, le jour même
>
> **L'option 3 a été retenue et appliquée en 2.62.0** : le chemin cookie est retiré partout, le
> chemin OAuth devient le chemin unique. Le reste de ce document est conservé **tel qu'il a été
> écrit avant la décision** — il est la trace du raisonnement, pas sa conclusion.
>
> Ce qui a emporté la décision, dans l'ordre : (a) le chemin cookie ne rapportait plus rien de
> mesurable (§4), (b) c'est le seul point qui touche littéralement les verbes prohibitifs du
> texte (§5.1), (c) l'extension étant publiée, elle distribuait la capacité à des tiers (§5.3).
> Les trois points annexes du §7 ont été traités dans le même lot : la phrase inexacte du README
> est corrigée, le filtrage par domaine devient sans objet, et les fichiers résiduels sont
> supprimés. Règle anti-retour consignée dans le [CLAUDE.md](CLAUDE.md) du module.

**Méthode.** Lecture du code source de la version 2.60.2 (état du dépôt au 2026-08-25),
`grep` exhaustif des appels réseau, lecture du texte légal à la source
(`code.claude.com/docs/en/legal-and-compliance`, récupéré le 2026-08-25), et trois mesures
d'état réel sur le poste (détaillées au §4).

---

## 1. Ce que dit le texte d'Anthropic

Section **Usage policy → Authentication and credential use** de la page
[legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance), citée
verbatim (récupérée le 2026-08-25) :

> * **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max,
>   Team, and Enterprise subscription plans and is designed to support ordinary use of Claude
>   Code and other native Anthropic applications.
> * **Developers** building products or services that interact with Claude's capabilities,
>   including those using the Agent SDK, should use API key authentication through Claude
>   Console or a supported cloud provider. Anthropic does not permit third-party developers to
>   offer Claude.ai login into their own applications, or to route requests through Free, Pro,
>   or Max plan credentials on behalf of their users. Moreover, **developers may not collect,
>   store, or intermediate Claude.ai credentials or session tokens** — sign-in to a Claude
>   account must complete through Anthropic's own flow.

Et, en clôture de section :

> Anthropic reserves the right to take measures to enforce these restrictions and may do so
> without prior notice.

**Lecture littérale utile pour la suite.** Trois verbes sont interdits aux développeurs sur les
identifiants claude.ai : *collect*, *store*, *intermediate*. Le texte ne les qualifie pas par
« sur vos serveurs » ni par « pour le compte de vos utilisateurs » — cette qualification
n'apparaît que dans la phrase précédente, celle sur le routage des requêtes d'inférence. Les
deux phrases sont séparées par « Moreover », ce qui se lit comme un ajout et non comme une
précision de la précédente.

**Ce que le texte ne dit pas.** Il ne mentionne pas le cas d'une extension qui ne quitte jamais
la machine de l'utilisateur, qui n'a qu'un utilisateur (celui-là même dont c'est le compte), et
qui ne fait passer aucune inférence. Ce cas n'est ni explicitement visé ni explicitement exclu.
C'est très exactement la zone où se situe cette extension, et c'est pourquoi ce document ne
tranche pas : il n'y a pas de réponse déductible du texte seul.

---

## 2. Cartographie exacte

### 2.1 Les deux chemins d'alimentation des barres de quota

Tout est concentré dans un seul fichier, [extension.js](extension.js). Aucun autre fichier de
l'extension ne touche à un élément d'authentification (vérifié par `grep` sur `accessToken`,
`credentials`, `sessionKey`, `token` — les hooks de [hooks/](hooks/) ne lisent que des
transcripts locaux et n'ont aucun accès credential).

L'orchestration est dans `fetchAndUpdate()`, [extension.js:756](extension.js#L756) :
le chemin cookie est essayé **en premier**, le chemin OAuth sert de repli.

#### Chemin A — cookie de session claude.ai (optionnel, actif seulement si réglé)

| Étape | Code | Ce qui est lu / fait |
|---|---|---|
| Lecture du cookie en cache | `readSessionKey()`, [extension.js:3041](extension.js#L3041) | Lit `~/.claude/quota-session-key.json` — un `sessionKey` claude.ai **en clair** |
| Appel usage | `fetchUsageWithSessionKey()`, [extension.js:3068](extension.js#L3068) | `GET https://claude.ai/api/organizations/{org_id}/usage`, en-tête `cookie: sessionKey=…` |
| Découverte de l'organisation | `discoverOrgIdWithSessionKey()`, [extension.js:3099](extension.js#L3099) | `GET https://claude.ai/api/organizations`, même cookie |
| Renouvellement du cookie | `refreshSessionKeyViaCdp()`, [extension.js:3113](extension.js#L3113) | Lance un Brave dédié sans fenêtre sur le profil `claudeCodeQuotaBar.braveUserDataDir`, se connecte à son port de débogage local 9223, appelle `Storage.getCookies`, retient le cookie `sessionKey` de domaine `claude.ai`, tue Brave |
| Écriture du cookie | `saveSessionKey()`, [extension.js:3046](extension.js#L3046) | Réécrit `~/.claude/quota-session-key.json` en clair |

Deux points de détail qui comptent pour l'audit :

- **`Storage.getCookies` est appelé sans filtre de domaine** ([extension.js:3126](extension.js#L3126)).
  L'extension reçoit donc en mémoire **tous** les cookies du profil Brave désigné, puis en
  sélectionne un seul. Rien d'autre n'est conservé ni écrit, mais l'ampleur de la lecture est
  celle du profil entier, pas celle d'un domaine. Le risque est proportionnel à ce que contient
  le profil désigné : sur un profil dédié il est marginal, sur le profil Brave quotidien il
  serait tout autre (16 cookies dans le profil réel — cf. §4).
- **Un disjoncteur existe** (`cookieRefreshBlockedUntil`, [extension.js:238](extension.js#L238)) :
  après un échec de renouvellement, le chemin cookie est mis en sommeil une heure et le repli
  OAuth prend le relais silencieusement.

#### Chemin B — jeton OAuth de Claude Code (repli, actif par défaut)

| Étape | Code | Ce qui est lu / fait |
|---|---|---|
| Lecture du jeton | `readToken()`, [extension.js:2852](extension.js#L2852) | Lit `~/.claude/.credentials.json`, champ `claudeAiOauth.accessToken` |
| Appel usage | `fetchUsageViaOAuth()`, [extension.js:2862](extension.js#L2862) | `GET https://api.anthropic.com/api/oauth/usage`, en-têtes `Authorization: Bearer …` et `anthropic-beta: oauth-2025-04-20` |

Le jeton n'est **jamais** recopié ailleurs : il est lu à chaque appel depuis le fichier de
Claude Code et passé directement dans l'en-tête. Aucune écriture, aucun cache de jeton.

### 2.2 Fichiers touchés sur le disque

Tous sous `~/.claude/`, aucun ailleurs.

| Fichier | Lu | Écrit | Sensibilité |
|---|---|---|---|
| `.credentials.json` | oui | **non** | Fichier de Claude Code lui-même ; l'extension n'y écrit jamais |
| `quota-session-key.json` | oui | **oui** | **Élevée** — cookie de session claude.ai en clair, qui vaut accès complet au compte tant qu'il est valide, pas seulement lecture de la page d'usage |
| `quota-org-id.json` | oui | oui | Faible — un UUID d'organisation |
| `quota-brave-pid.json` | oui | oui | Nulle — un PID, pour pouvoir refermer le Brave lancé |
| `usage-cache.json` | oui | oui | Faible — la réponse JSON d'usage (pourcentages, dates de reset) |

### 2.3 Tous les appels réseau de l'extension, sans exception

`grep` sur `https.get|https.request|http.get|http.request|fetch(|axios|WebSocket` dans tout le
code publié : **six** occurrences, toutes dans [extension.js](extension.js), et pas une de plus.

| # | Destination | Ce qui part | Ligne |
|---|---|---|---|
| 1 | `api.anthropic.com/api/oauth/usage` | le jeton OAuth (en-tête `Authorization`) | [2867](extension.js#L2867) |
| 2 | `claude.ai/api/organizations/{id}/usage` | le cookie `sessionKey` | [3053](extension.js#L3053) via [3080](extension.js#L3080) |
| 3 | `claude.ai/api/organizations` | le cookie `sessionKey` | [3100](extension.js#L3100) |
| 4 | `http://127.0.0.1:9223/json/version` | rien (ping local) | [2911](extension.js#L2911) |
| 5 | `http://127.0.0.1:9223/json/version` | rien (ping local) | [2988](extension.js#L2988) |
| 6 | WebSocket vers `127.0.0.1:9223` | rien en sortie ; **reçoit** les cookies du profil | [3009](extension.js#L3009) |

Les trois premiers vont chez Anthropic. Les trois derniers ne quittent pas la boucle locale.

### 2.4 Ce qui ne sort pas — vérifié, pas supposé

- **Aucune télémétrie, aucun analytics.** `grep` sur `telemetry|analytics|posthog|sentry` :
  zéro occurrence dans tout le code publié.
- **Aucun tiers.** Il n'existe aucune destination réseau autre que les six ci-dessus.
- **Aucun journal ne contient de secret.** Les huit `console.log` de l'extension portent sur des
  compteurs de groupes, un canari d'onglets, des échecs de réouverture — jamais un jeton ni un
  cookie (vérifié un par un).
- **Le webview est verrouillé.** Politique de sécurité `default-src 'none'`,
  `localResourceRoots: []` ([panel.js:148](panel.js#L148) et [panel.js:230](panel.js#L230)) :
  la vue du panneau ne peut charger aucune ressource distante, ni émettre aucune requête.
- **Aucune inférence n'est routée.** L'extension n'appelle aucun point d'entrée de modèle. Elle
  ne lit qu'un endpoint d'usage — deux nombres et deux dates.
- **Aucun contenu de conversation ne part.** Les coûts et pourcentages de contexte affichés sont
  calculés sur les transcripts locaux, jamais téléversés.

---

## 3. Synthèse en une phrase

Sur cette machine, deux identifiants du compte Anthropic sont lus par du code tiers : le jeton
OAuth de Claude Code (lu, jamais recopié) et un cookie de session claude.ai (lu **et recopié en
clair dans un fichier**, `quota-session-key.json`). Chacun ne part que vers Anthropic elle-même,
en HTTPS, pour lire un seul endpoint de compteurs d'usage. Rien d'autre ne sort, vers personne.

---

## 4. État réel mesuré le 2026-08-25 — trois constats qui changent le chiffrage

Ces mesures ont été prises sur le poste le jour de l'audit ; elles ne sont pas déduites du code.

1. **Le chemin cookie est configuré mais mort de fait.** Le réglage
   `claudeCodeQuotaBar.braveUserDataDir` vaut `C:\OctopusData\BraveOctopus` dans les paramètres
   utilisateur de VS Code — donc le chemin est théoriquement actif. Mais la base de cookies de
   ce profil contient **16 cookies sur 10 domaines, et aucun sur `claude.ai`** (uniquement
   `.claude.com` et `platform.claude.com`). Or le code cherche précisément un cookie `sessionKey`
   de domaine `claude.ai` ([extension.js:3127](extension.js#L3127)). Le renouvellement échoue
   donc à coup sûr, le disjoncteur se ferme, et le repli OAuth sert.

2. **Le cookie en cache date du 25 mai 2026** (`quota-session-key.json`, horodatage interne
   `2026-05-25 18:05`, 131 caractères — valeur non affichée et non extraite). La documentation
   de l'extension elle-même donne une rotation de session d'environ 30 jours. Ce cookie est donc
   selon toute vraisemblance expiré depuis trois mois. Il n'a **pas** été testé contre l'API :
   ce test aurait consisté à faire exactement l'appel que cet audit examine, ce qui n'aurait rien
   appris d'utile au regard du reste. À retenir : le fichier reste sur le disque, expiré ou non.

3. **Le chemin OAuth fonctionne, aujourd'hui, sans limitation.** Un appel unique à
   `api.anthropic.com/api/oauth/usage` avec le jeton local a répondu **HTTP 200** et a renvoyé
   l'intégralité des champs consommés par le panneau : `five_hour`, `seven_day`, `limits`, plus
   les fenêtres par modèle. Le parsing du panneau (`quotaState()`,
   [extension.js:1435](extension.js#L1435)) ne lit que ces champs — donc le repli OAuth couvre
   **100 %** de ce que la barre affiche, sans dégradation.

**Conséquence directe.** Les barres de quota de ce poste sont alimentées par le chemin OAuth
depuis vraisemblablement fin juin, et l'utilisateur n'a constaté aucune panne. Le chemin cookie
n'apporte, en pratique et sur cette machine, plus rien depuis des mois.

### 4.1 La justification technique du chemin cookie s'est affaiblie

Le chemin cookie existe pour une raison documentée : le point d'entrée OAuth était sévèrement
limité en débit, ce qui rendait le suivi d'usage inutilisable. Les deux tickets cités par le
README ont été vérifiés le 2026-08-25 via l'API GitHub :

| Ticket | Titre | État |
|---|---|---|
| [#31021](https://github.com/anthropics/claude-code/issues/31021) | OAuth usage API (/api/oauth/usage) returns persistent 429 rate limit | **Fermé** le 2026-03-06, motif `not_planned` |
| [#31637](https://github.com/anthropics/claude-code/issues/31637) | /api/oauth/usage endpoint aggressively rate limits, making usage monitoring unusable | **Fermé** le 2026-06-01, par le robot d'inactivité |

Honnêteté sur ce point : « fermé » ne veut pas dire « corrigé ». Aucun des deux n'a été fermé par
un correctif annoncé — l'un est classé « non prévu », l'autre est tombé par inactivité. Ce qui
est établi, c'est (a) qu'Anthropic ne traite pas ces tickets, et (b) qu'au 2026-08-25 sur ce
poste, l'endpoint répond 200. Il n'est pas exclu qu'une limitation revienne selon la charge ou le
volume d'appels ; le poll par défaut est de 5 minutes, avec dédoublonnage entre fenêtres VS Code.

---

## 5. Où l'extension est en tension avec le texte — gradué, sans verdict

Deux niveaux très différents, à ne pas confondre.

### 5.1 Le chemin cookie — tension frontale sur les mots du texte

Le texte interdit de *store* et d'*intermediate* des « Claude.ai credentials or session tokens ».
L'extension fait littéralement les deux, sur le poste de l'utilisateur :

- elle **écrit** un cookie de session claude.ai dans un fichier qu'elle crée
  (`quota-session-key.json`) — c'est un *store*, au sens propre du verbe ;
- elle **présente** ce cookie à claude.ai à la place du navigateur — c'est un *intermediate*,
  au sens propre.

Ce qui plaide en sens inverse, factuellement : le cookie ne quitte jamais la machine, l'unique
« utilisateur » est le propriétaire du compte, aucun *login flow* n'est proposé ni détourné
(l'extension ne sait pas se connecter, elle lit un profil déjà connecté), et aucune inférence
n'est routée. La phrase interdisant *store*/*intermediate* apparaît toutefois **sans** la
qualification « on behalf of their users » qui borne la phrase précédente.

### 5.2 Le chemin OAuth — tension plus faible, mais réelle

Le texte dit que l'authentification OAuth « is designed to support ordinary use of Claude Code
and other native Anthropic applications ». Une extension VS Code tierce n'est ni Claude Code ni
une application native d'Anthropic. Elle lit le jeton posé par Claude Code sur le disque et s'en
sert pour appeler un endpoint d'Anthropic.

Ce qui distingue nettement ce cas du précédent : ce n'est pas un identifiant claude.ai au sens de
la phrase sur *store*/*intermediate* (c'est le jeton de Claude Code, pas un cookie de session
web) ; il n'est jamais recopié ni stocké ; l'appel ne consomme aucun quota d'inférence ; et
l'usage reste strictement celui du titulaire. La formule « intended exclusively […] designed to
support » décrit une intention d'usage, pas une interdiction énoncée avec un verbe prohibitif —
contrairement au « may not collect, store, or intermediate » du chemin cookie.

### 5.3 Le facteur aggravant à ne pas manquer : c'est publié

L'extension est publiée sur le Marketplace VS Code sous l'identité `AnthonyDame` et son code est
public sur `github.com/Depot404/claude-code-quota-bar`. Deux conséquences distinctes du risque
personnel :

- la technique de lecture du cookie claude.ai est **publiquement documentée**, nominativement,
  y compris dans le README (section *How the quota fetch works*, qui décrit l'extraction par
  navigateur pas à pas) ;
- l'extension est **distribuée** : d'autres personnes peuvent activer ce chemin sur leur propre
  compte. C'est précisément le cas de figure — un développeur tiers dont le produit intermédie
  des jetons de session claude.ai pour ses utilisateurs — que la phrase du texte semble viser le
  plus directement, même si chaque instance reste locale à son poste.

À l'inverse, le réglage est **vide par défaut** : une installation depuis le Marketplace n'active
jamais le chemin cookie toute seule, ne lance aucun navigateur, et n'écrit jamais
`quota-session-key.json`. Il faut une action délibérée de l'utilisateur, dûment documentée avec
son niveau de risque. Le produit tel qu'il est distribué n'expose donc rien par défaut ; il
*offre* la possibilité, avec le mode d'emploi.

---

## 6. Options

Quatre options, du statu quo au retrait complet. Chacune est chiffrée en exposition retirée et en
fonctionnalité perdue. **Aucune n'est recommandée ici.**

### Option 1 — Ne rien changer

**Ce qui est retiré :** rien.

**Ce qui est perdu :** rien.

**Exposition maintenue :** le stockage local d'un cookie de session claude.ai en clair ; la
présentation de ce cookie à claude.ai ; la publication nominative de la technique ; la
disponibilité du chemin pour d'autres utilisateurs. Le chemin OAuth continue également.

**À savoir pour évaluer :** sur ce poste, tout cela est maintenu pour un bénéfice mesuré nul —
le chemin cookie ne fonctionne plus depuis des mois (§4) et le repli OAuth couvre l'affichage à
100 %. Le fichier `quota-session-key.json` reste sur le disque.

### Option 2 — Retirer le chemin cookie du produit publié, le garder pour soi

Suppression du réglage `braveUserDataDir` et du code de lecture de cookie **dans la version
distribuée** ; conservation du chemin dans une version locale non publiée.

**Ce qui est retiré :** la distribution de la capacité à des tiers ; la documentation publique de
la technique ; le fait qu'une autre personne puisse activer ce chemin sur son compte. C'est
exactement le point du §5.3 qui vise le plus directement le texte.

**Ce qui est perdu :** rien pour l'utilisateur (il garde le chemin) ; pour les autres, le repli
sur OAuth, mesuré fonctionnel au §4.

**Exposition maintenue :** le *store* et l'*intermediate* locaux, littéralement — donc la
tension du §5.1 reste entière pour l'usage personnel. Coût de maintenance nouveau : deux
variantes de code à tenir en parallèle, avec le risque classique que la variante privée reparte
un jour dans une publication par inadvertance.

### Option 3 — Retirer le chemin cookie partout, garder OAuth

Suppression du code de lecture de cookie, du réglage, des passages de documentation, et
suppression du fichier `~/.claude/quota-session-key.json`. Le chemin OAuth devient le chemin
unique, et non plus le repli.

**Ce qui est retiré :** tout le §5.1 — plus aucun identifiant claude.ai n'est lu, stocké ni
présenté ; plus aucun cookie en clair sur le disque ; plus aucun lancement de navigateur ; plus
aucune lecture de l'ensemble des cookies d'un profil ; et le §5.3 dans la foulée. Environ 180
lignes de code disparaissent, dont tout le client de débogage navigateur et la gestion du cycle
de vie de Brave — donc aussi de la complexité et deux fichiers d'état de moins.

**Ce qui est perdu :** la résistance à une limitation de débit sur l'endpoint OAuth, si elle
revenait. C'est le seul avantage réel du chemin cookie. À l'instant de l'audit, cet avantage vaut
zéro : l'endpoint répond 200 et couvre tous les champs affichés. Il ne vaudrait quelque chose que
si la limitation revenait — cas dans lequel les barres afficheraient une donnée vieillissante,
sans autre dégradation (le cache est conservé et l'âge est affiché).

**Exposition maintenue :** le §5.2 — la lecture du jeton OAuth de Claude Code par du code tiers.

### Option 4 — Retirer les deux chemins : plus aucun accès aux compteurs d'usage

Suppression du chemin cookie et du chemin OAuth. L'extension ne lit plus aucun identifiant.

**Ce qui est retiré :** toute l'exposition d'authentification, sans reste. Plus aucun fichier de
credential n'est ouvert par l'extension. Les §5.1 et §5.2 disparaissent tous les deux.

**Ce qui est perdu :**

- **Les barres de quota disparaissent** (5 h, 7 j, et les barres hebdomadaires par modèle) —
  c'est-à-dire ce qui a donné son nom au projet et la fonction pour laquelle il a été écrit.
- **Le montant par fenêtre disparaît aussi**, moins évidemment : le coût affiché par fenêtre est
  calculé localement mais **borné par la date de reset venue de l'API**
  (`windowCost()`, [extension.js:1427](extension.js#L1427) — retourne `null` sans `resetsAt`).
  Sans API, plus de bornes, donc plus de montant par fenêtre.
- **Ce qui survit intégralement** : la liste des conversations et leurs états, le pourcentage de
  contexte, le coût par conversation et par tour, les groupes et vagues, les sons, les accusés de
  lecture, le clic-vers-l'onglet. Tout cela est calculé sur les transcripts locaux et ne dépend
  d'aucun identifiant. L'extension resterait pleinement utile — mais amputée de sa fonction
  d'origine.

**Exposition maintenue :** aucune, sur ce plan.

### Tableau comparatif

| | Cookie claude.ai stocké | Cookie présenté à claude.ai | Capacité distribuée à des tiers | Jeton OAuth lu | Barres de quota | Montant par fenêtre |
|---|---|---|---|---|---|---|
| **Option 1** — statu quo | oui | oui | oui | oui | oui | oui |
| **Option 2** — dépublier le chemin | oui (local) | oui (local) | **non** | oui | oui | oui |
| **Option 3** — retrait du cookie | **non** | **non** | **non** | oui | oui | oui |
| **Option 4** — retrait total | **non** | **non** | **non** | **non** | **non** | **non** |

---

## 7. Trois points annexes relevés en cours d'audit

Ils ne dépendent d'aucune des options et sont signalés tels quels.

1. **Le premier point de la section « Privacy and data handling » du README est inexact.** Il
   affirme : « The extension reads **only** the OAuth access token from `~/.claude/.credentials.json` »
   ([README.md:472](README.md#L472)). C'est faux dès que le chemin cookie est activé — le cookie de
   session claude.ai est lu aussi. Le README le décrit correctement ailleurs, notamment au point
   sur `quota-session-key.json` ([README.md:481](README.md#L481)) qui est, lui, remarquablement
   franc sur le niveau de risque. C'est le mot « only » du premier point qui contredit le reste de
   la même section.

2. **La lecture de cookies n'est pas filtrée par domaine.** `Storage.getCookies` sans paramètre
   ([extension.js:3126](extension.js#L3126)) ramène tout le profil. Un filtrage par `urls:
   ['https://claude.ai']` réduirait la surface de lecture sans rien changer au fonctionnement.
   Pertinent seulement si le chemin cookie est conservé (options 1 et 2).

3. **Le fichier `quota-session-key.json` survit à la désactivation du chemin.** Vider le réglage
   `braveUserDataDir` désactive le code mais ne supprime pas le fichier déjà écrit — il resterait
   sur le disque, en clair. Sur ce poste, il est là depuis le 2026-05-25. Toute option qui vise à
   retirer le stockage doit inclure la suppression du fichier, pas seulement celle du code.
