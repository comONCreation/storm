# Storm

L'expérience **PhpStorm** dans Visual Studio Code : **Search Everywhere**, **Find in Files**, **Replace in Files** et la fenêtre **Find**, avec une UI calquée sur la *New UI* des IDE JetBrains et un **index persistant** qui rend les recherches quasi instantanées, plus le thème **Storm Dark** qui reprend leur coloration syntaxique.

> Projet indépendant, inspiré des IDE JetBrains. Il n'est ni affilié à JetBrains ni approuvé par JetBrains.

## Installation

Téléchargez le fichier `storm-x.y.z.vsix` de la dernière version sur la page des [releases](https://github.com/comONCreation/storm/releases/latest), puis :

```bash
code --install-extension storm-x.y.z.vsix
```

ou, dans VS Code : Extensions → `…` → **Install from VSIX…**. Pour mettre à jour, installez de la même façon le `.vsix` d'une version plus récente.

Le thème s'active via *Préférences → Thème de couleur → Storm Dark*.

## Fonctionnalités

### Search Everywhere — `Shift` `Shift`
Popup à onglets **All · Classes · Files · Symbols · Actions · Text**.

- Correspondance floue façon *CamelHumps* : `UsCo`, `uco` ou `user con` trouvent `UserController` ; `*troller` cherche au milieu du nom ; un espace final impose la fin du nom.
- Classement à la JetBrains : nom exact > préfixe > débuts de mots > caractères contigus ; noms courts et fichiers récents favorisés.
- Fichiers : `ctrl/user` filtre par répertoire, `UserController.php:42:10` ouvre à la ligne/colonne.
- Symboles : `UserService::findAll`, `Service.fetch`, `App\Http\UserController`.
- Requête vide → **fichiers récents**.
- `Tab` / `Shift+Tab` changent d'onglet, `Shift+Entrée` ouvre dans un split.
- **Include non-project items** (bibliothèques, ex. `vendor/`) : case à cocher, ou appuyez une seconde fois sur le raccourci. Si rien n'est trouvé dans le projet, les bibliothèques sont automatiquement incluses.

### Find in Files — `Ctrl+Shift+F` / Replace in Files — `Ctrl+Shift+R`
- Résultats **en direct pendant la frappe**, une ligne par occurrence (occurrences multiples fusionnées), nom de fichier et numéro de ligne à droite.
- **Aperçu de code** sous la liste (coloration syntaxique aux couleurs de votre thème VS Code, toutes les occurrences surlignées, ligne courante mise en évidence), séparateur redimensionnable ; la liste des résultats est colorée de la même façon.
- Options **Cc** (casse, `Alt+C`), **W** (mots entiers, `Alt+W`), **.\*** (regex, `Alt+X`), **File mask** (`Alt+F`, ex. `*.php, !*.blade.php`).
- **File mask** : globs séparés par des virgules (`*` dans un nom, `**` sur plusieurs dossiers, `?`, `{a,b}`), `!` pour exclure ; un motif sans `/` porte sur le nom du fichier, avec `/` sur le chemin relatif. La flèche (ou `↓` / `Alt+↓` dans le champ) liste **toujours toutes les entrées** : vos 10 derniers masques utilisés (par projet), puis des masques courants. Choisir une entrée active le filtre.
- Portées **In Project** (`Alt+P`), **Module** (multi-root, `Alt+M`), **Directory** (`Alt+D`, ou clic droit sur un dossier → *Find in Files…*), **Scope** (`Alt+S` : All Places, All Places Including Ignored Files, Project Files, Open Files, Current File, Recently Viewed Files). Les fichiers ignorés par git sont aussi cherchés quand on choisit explicitement leur dossier (portée Directory).
- Recherche multi-ligne (`Shift+Entrée` insère un saut de ligne), indépendante des fins de ligne LF/CRLF.
- Le texte sélectionné dans l'éditeur pré-remplit la recherche ; la dernière recherche et ses options sont mémorisées.
- **Replace** : aperçu barré/inséré dans la liste, groupes `$1`, `$<nom>`, `$&` en mode regex, **Replace** (ligne sélectionnée, `Alt+R`) et **Replace All** (`Alt+A`, avec confirmation). Les modifications passent par un `WorkspaceEdit` : annulables avec `Ctrl+Z`.
- **Épingle** : garde le popup ouvert, les résultats s'ouvrent dans le groupe voisin.
- `Entrée` ouvre, `Alt+Entrée` ouvre dans un split, `Échap` ferme, `Ctrl+Entrée` → fenêtre Find.

### Fenêtre Find (panneau)
Toutes les occurrences, groupées par répertoire puis fichier (ou à plat), avec compteur, *Rerun*, *Edit Search*, exclusion d'un nœud, et navigation **occurrence suivante / précédente** (`Ctrl+Alt+↓` / `Ctrl+Alt+↑`).

### Autres raccourcis (keymap PhpStorm Windows/Linux — macOS entre parenthèses)
| Action | Raccourci |
|---|---|
| Search Everywhere | `Shift` `Shift` |
| Go to Class | `Ctrl+N` (`⌘O`) |
| Go to File | `Ctrl+Shift+N` (`⌘⇧O`) |
| Go to Symbol | `Ctrl+Alt+Shift+N` (`⌘⌥O`) |
| Find Action | `Ctrl+Shift+A` (`⌘⇧A`) |
| Recent Files | `Ctrl+E` (`⌘E`) |
| Find in Files | `Ctrl+Shift+F` (`⌘⇧F`) |
| Replace in Files | `Ctrl+Shift+R` (`⌘⇧R`) |
| Occurrence suivante / précédente | `Ctrl+Alt+↓` / `Ctrl+Alt+↑` |

Ces raccourcis remplacent ceux de VS Code (ex. `Ctrl+N` = nouveau fichier) : modifiez-les dans *Raccourcis clavier* si besoin.

**Conflit avec une autre extension de raccourcis** (ex. *JetBrains Keybindings* / *IntelliJ IDEA Keybindings*) : entre deux extensions, VS Code applique celle chargée en dernier, et une extension ne peut pas imposer sa priorité. Storm détecte ces conflits au démarrage et propose d'ajouter ses raccourcis dans votre `keybindings.json` utilisateur (qui passe toujours en premier). Commande équivalente : **Storm: Resolve Shortcut Conflicts**.

### Thème Storm Dark
*Préférences → Thème de couleur* → **Storm Dark** : l'interface **Dark 2026** de VS Code, avec la **coloration syntaxique des IDE JetBrains** (PhpStorm, Rider, IntelliJ…), celle de leur thème par défaut **Islands Dark**, identique à celle du schéma « Dark » de la New UI. Seuls la coloration du code et la couleur du texte par défaut changent ; barres, onglets, panneaux et fond de l'éditeur sont ceux de Dark 2026.

| Élément | Couleur |
|---|---|
| Texte, opérateurs, noms de classes, appels de fonctions | `#BCBEC4` |
| Mots-clés (`public`, `function`, `return`, `true`, `$this`, types…) | `#CF8E6D` |
| Chaînes | `#6AAB73` (échappements `#CF8E6D`) |
| Nombres | `#2AACB8` |
| Commentaires | `#7A7E85` |
| Documentation (PHPDoc, JSDoc) | `#5F826B` italique, tags `#67A37C`, types `#ABADB3` |
| Déclarations de fonctions / méthodes, `__construct` | `#56A8F5` |
| Appels de fonctions et de méthodes (`back()`, `$x->save()`) | `#57AAF7` |
| Appels statiques PHP (`Model::create()`) | `#CF8E6D` |
| Variables PHP et `$this` | `#9876AA` |
| Accès aux propriétés PHP (`$x->id`) | `#CF8E6D` |
| Arguments nommés PHP (`folderId:`) | `#467CDA` |
| Appels de fonctions JS/TS (`setConfirming(true)`, `React.useState()`) | `#56A8F5` |
| Variables locales, `const` et imports JS/TS, opérateur `=>` | `#BCBEC4` |
| Globales JS (`window`, `document`, `console`) | `#C77DBB` italique |
| Propriétés (JS/TS…), clés JSON | `#C77DBB` |
| Constantes, membres statiques | `#C77DBB` italique |
| Attributs / annotations / décorateurs | `#B3AE60` |
| Balises HTML / XML (`<div>`) | `#D5B778` |
| Composants JSX / TSX (`<Button>`, `<AlertDialog.Content>`) | `#2FBAA3` |
| Composants importés d'un module `'use client'` | `#9C9CFF` |
| Paramètres de type | `#16BAAC` |

#### Coloration JS/TS fidèle à WebStorm

Certaines couleurs de WebStorm / PhpStorm sont impossibles à obtenir avec un thème seul : le serveur TypeScript marque un paramètre de type fonction (`onReset`) comme une déclaration de fonction, une propriété de type fonction (`onReset?: () => void`) comme une méthode, et un thème ne voit pas d'où vient un composant JSX. Avec Storm Dark, l'extension analyse donc les fichiers JS/TS (compilateur TypeScript, chargé seulement à l'ouverture d'un tel fichier) et colore par-dessus le thème :
- les **paramètres** et leurs usages, quel que soit leur type (texte) ;
- les **propriétés de type fonction** des types, interfaces et classes (`#C77DBB`) ;
- les **composants importés d'un module `'use client'`** (`#9C9CFF`, « JSX client component » de WebStorm) : imports relatifs, alias `paths` du `tsconfig.json` / `jsconfig.json` (y compris via `extends` / `references`) et paquets de `node_modules`. Les ré-exports (fichiers `index` « barrel ») ne sont pas suivis.

Désactivable avec `storm.jetbrainsHighlighting` ; couleurs modifiables via `workbench.colorCustomizations` (`storm.parameterForeground`, `storm.fieldForeground`, `storm.jsxClientComponentForeground`).

Valeurs lues dans les schémas officiels du dépôt open source JetBrains/intellij-community (`islands/IslandSchemeDark.xml` et `expUI/expUI_darkScheme.xml`). Ces schémas héritent de Darcula sans redéfinir les couleurs propres au PHP : PhpStorm garde donc celles de Darcula pour les variables, les propriétés et les arguments nommés (valeurs relevées sur une capture de PhpStorm 2025.3 en Islands Dark). Le thème définit aussi les couleurs sémantiques (Intelephense, TypeScript, C#…). Pour aller plus loin : police **JetBrains Mono** (`"editor.fontFamily": "JetBrains Mono"`, taille 13, interligne 22).

## Pourquoi c'est rapide

Comme PhpStorm, Storm **indexe** le projet au lieu de le parcourir à chaque recherche :

1. **Worker dédié** : l'indexation et toutes les recherches tournent dans un `worker_thread`, jamais sur le thread de l'hôte d'extensions — VS Code reste fluide.
2. **Index trigrammes** (construit sans table de hachage : les trigrammes de chaque fichier sont accumulés puis répartis en une passe par tri par comptage) (même principe que le `TrigramIndex` d'IntelliJ) : chaque fichier est réduit à l'ensemble de ses séquences de 3 caractères. Une requête n'est vérifiée que dans les fichiers qui contiennent *tous* ses trigrammes (intersection de listes triées). Pour les regex, les littéraux obligatoires sont extraits (`function\s+index` → `function`, `index`).
3. **Cache de contenu en mémoire** (LRU, 256 Mo par défaut) préchauffé en arrière-plan : la vérification des candidats se fait sans I/O disque.
4. **Index de symboles** (équivalent léger des *stub indexes*) : classes, interfaces, traits, enums, fonctions, méthodes, propriétés et constantes pour PHP, JS/TS, Python, Java/Kotlin/C#, Go, Rust et Ruby — sans dépendre d'un serveur de langage.
5. **Persistance compacte** : les listes de fichiers par trigramme sont stockées en écarts codés sur un nombre variable d'octets (≈ 1 octet par entrée au lieu de 4), dans un segment de base fait de quelques grands tableaux, chargé d'un bloc ; la liste des fichiers et les symboles sont compressés avec zlib. Sur un projet Laravel de 25 000 fichiers : 28 Mo sur disque, ≈ 190 Mo en mémoire, chargement en ≈ 0,25 s, première indexation complète en ≈ 5 s. À la réouverture, seuls les fichiers modifiés entre-temps (mtime/taille) sont réindexés.
6. **Incrémental** : les modifications sur disque (watcher) et le contenu **non sauvegardé** des éditeurs sont pris en compte en temps réel.
7. **Streaming et annulation** : les résultats arrivent par lots ; chaque frappe annule la recherche précédente.

Ordre de grandeur mesuré par les tests (projet synthétique de 3 000 fichiers PHP, 183 000 symboles) : indexation complète ≈ 1 s, recherche d'un terme rare ≈ 3 ms, 1 000 lignes d'un terme fréquent ≈ 6 ms, recherche de fichier ≈ 7 ms, recherche de symbole ≈ 45 ms.

Pendant l'indexation initiale, la recherche fonctionne déjà (les fichiers non encore indexés sont lus directement) ; la barre d'état affiche la progression.

## Paramètres

| Paramètre | Défaut | Rôle |
|---|---|---|
| `storm.exclude` | `.git`, `node_modules`, `.claude/worktrees`, `var/cache`, dumps de debug et logs Laravel (`storage/debugbar`, `storage/inertia-devtools`, `storage/clockwork`, `storage/logs`), `*.min.js`… | Exclus de l'index (`files.exclude` toujours respecté) |
| `storm.respectSearchExclude` | `true` | Respecte aussi `search.exclude` |
| `storm.useIgnoreFiles` | `true` | N'indexe pas les fichiers ignorés par git (`.gitignore`, `.git/info/exclude`) |
| `storm.alwaysIndex` | `**/_ide_helper*.php`, `**/.phpstorm.meta.php` | Fichiers indexés même si git les ignore |
| `storm.libraryFolders` | `**/vendor/**` | Racines « bibliothèque » (non-project items), indexées même si git les ignore |
| `storm.maxFileSizeKB` | `2560` | Taille max indexée (comme PhpStorm : 2,5 Mo) |
| `storm.maxFiles` | `300000` | Nombre max de fichiers |
| `storm.contentCacheMB` | `256` | Budget mémoire du cache de contenu |
| `storm.persistIndex` | `true` | Sauvegarde de l'index sur disque |
| `storm.popupResultLimit` | `1000` | Lignes max dans le popup |
| `storm.findWindowResultLimit` | `50000` | Lignes max dans la fenêtre Find |
| `storm.useLanguageServerSymbols` | `false` | Fusionne les symboles des serveurs de langage (ex. Intelephense) |
| `storm.previewColors` | `theme` | Couleurs syntaxiques de l'aperçu et de la liste : celles du thème VS Code actif (`theme`, avec `editor.tokenColorCustomizations`) ou la palette JetBrains (`jetbrains`) |
| `storm.closeOnFocusLoss` | `true` | Ferme le popup quand un autre éditeur prend le focus (sauf épinglé) |
| `storm.jetbrainsHighlighting` | `true` | Avec Storm Dark, coloration JS/TS fidèle à WebStorm (paramètres, propriétés de type fonction, composants `'use client'`) |

Commande **Storm: Invalidate Caches and Rebuild Index** pour reconstruire l'index.

### Fichiers ignorés par git

Par défaut (`storm.useIgnoreFiles`), Storm n'indexe pas les fichiers ignorés par git : tous les `.gitignore` du projet (et ceux des dossiers parents jusqu'à la racine du dépôt) ainsi que `.git/info/exclude`, avec la syntaxe et les priorités de git (`!` pour ré-inclure, règles des `.gitignore` profonds prioritaires…). Un `.gitignore` modifié est pris en compte aussitôt. Les `.gitignore` étant commités, toute l'équipe profite des mêmes exclusions sans réglage.

Exceptions, toujours indexées même si git les ignore :
- les **bibliothèques** (`storm.libraryFolders`, `vendor` par défaut), pour que *Go to Class* trouve les classes des dépendances, comme dans PhpStorm ;
- les fichiers de `storm.alwaysIndex` (par défaut les fichiers d'aide IDE de Laravel : `_ide_helper*.php`, `.phpstorm.meta.php`).

Les fichiers ignorés ne sont pas indexés mais restent cherchables ponctuellement : portée **Scope → All Places, Including Ignored Files**, ou portée **Directory** sur leur dossier (ex. *Find in Files…* sur `build/`). Ils sont alors lus directement, sans index.

Pour exclure un dossier qui n'est pas dans le `.gitignore`, ajoutez-le à `search.exclude` dans le `.vscode/settings.json` du projet (partagé avec l'équipe s'il est commité) plutôt qu'à `storm.exclude` : une valeur de projet de `storm.exclude` remplace la liste par défaut au lieu de s'y ajouter.

## Limites connues
- Le popup est une webview ouverte comme onglet dans le groupe d'éditeurs actif (VS Code ne permet pas de vraie fenêtre flottante) ; il se ferme comme un popup (Échap, ouverture d'un résultat, perte de focus).
- L'extraction de symboles repose sur des expressions régulières : très robuste sur du code formaté normalement, moins sur des déclarations compactées sur une seule ligne.
- Le fichier d'exclusion global de git (`core.excludesFile`) n'est pas lu, seulement les `.gitignore` et `.git/info/exclude`.
- Seuls les fichiers du système de fichiers local (ou distant via Remote SSH/WSL/Containers) sont indexés ; pas de support des espaces de travail virtuels.

## Développement

```bash
npm install
npm run build      # bundle esbuild → dist/
npm test           # tests unitaires + intégration du worker
npm run package    # produit storm-x.y.z.vsix
npm run theme      # régénère themes/storm-dark.json depuis le Dark 2026 du VS Code installé
npm run theme:preview  # out-test/theme-preview.html : Dark 2026 vs Storm Dark (moteur TextMate de VS Code)
```

`F5` dans VS Code lance une fenêtre *Extension Development Host*. `test/harness/` permet de prévisualiser la webview dans un navigateur (`node test/harness/serve.mjs`).

Architecture :

```
src/
  extension.ts            activation, commandes, barre d'état
  index/worker.ts         index (trigrammes, symboles, noms), recherche, remplacement, persistance
  index/trigram.ts        encodage des trigrammes, listes de postings, intersection
  index/symbols.ts        extraction des symboles par langage
  index/indexClient.ts    RPC hôte ↔ worker
  index/fileTracker.ts    listage, watcher, documents non sauvegardés, règles git ignore
  index/gitignore.ts      moteur de règles .gitignore (syntaxe et priorités de git)
  jsColors/               coloration JS/TS fidèle à WebStorm (analyse TypeScript, résolution des imports, décorations)
  shared/fuzzy.ts         matcher flou CamelHumps (type MinusculeMatcher)
  shared/query.ts         compilation regex, littéraux obligatoires, masques de fichiers
  ui/popup.ts             contrôleur de la webview (Search Everywhere / Find in Files)
  ui/findResults.ts       fenêtre Find (TreeView)
  ui/searchService.ts     portées, remplacement (WorkspaceEdit)
  webview/                UI (TypeScript sans framework) + mini coloriseur syntaxique
scripts/theme/            générateur du thème Storm Dark (palette JetBrains dans palettes.js)
```
