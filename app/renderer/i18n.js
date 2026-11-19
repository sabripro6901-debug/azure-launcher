'use strict';
// French as a second language (AUDIT M8). The launcher is written in English; this file translates what the window
// shows: every text node and the placeholder / title / aria-label of every element, also text that appears later.
// Whole texts are looked up in FR; texts with numbers or names in them go through PATTERNS. Anything not listed
// (names of instances, mods, worlds, the game's own log) stays as it is. Elements with data-raw are never touched.
// The language follows the system (French Windows -> French) unless the player picks one in Settings.

const FR = {
  // navigation and home
  'Azure Launcher': 'Azure Launcher',
  Home: 'Accueil',
  Instances: 'Instances',
  Settings: 'Paramètres',
  Accounts: 'Comptes',
  Account: 'Compte',
  Play: 'Jouer',
  Playing: 'En jeu',
  Launch: 'Lancer',
  'Starting the game…': 'Démarrage du jeu…',
  'Downloading game files…': 'Téléchargement des fichiers du jeu…',
  'Getting ready…': 'Préparation…',
  'Open the logs': 'Ouvrir les journaux',
  'Stop the game?': 'Arrêter le jeu ?',
  "Minecraft will close right away. Anything you haven't saved in the game is lost.": 'Minecraft va se fermer tout de suite. Ce qui n’a pas été sauvegardé dans le jeu sera perdu.',
  'Stop game': 'Arrêter le jeu',
  'The game closed unexpectedly.': 'Le jeu s’est fermé de façon inattendue.',
  'Not signed in': 'Non connecté',
  'Sign in': 'Se connecter',
  'Azure features not available on this version': 'Fonctions Azure indisponibles sur cette version',
  'Azure features not available on this version.': 'Fonctions Azure indisponibles sur cette version.',
  'Includes Azure Client': 'Avec Azure Client',
  'No Azure': 'Sans Azure',
  'Mods are off (no Fabric for this version)': 'Mods désactivés (pas de Fabric pour cette version)',
  Edit: 'Modifier',
  Escape: 'Échap',
  DEV: 'DEV',
  'AZURE CLIENT': 'AZURE CLIENT',
  // accounts and sign-in
  'Add account': 'Ajouter un compte',
  'Sign in with Microsoft': 'Se connecter avec Microsoft',
  'Open the Microsoft page, type this code, and sign in with the account that owns Minecraft: Java Edition.': 'Ouvrez la page Microsoft, tapez ce code et connectez-vous avec le compte qui possède Minecraft: Java Edition.',
  'Open Microsoft page': 'Ouvrir la page Microsoft',
  'Copy code': 'Copier le code',
  'Waiting for you to finish in the browser…': 'En attente de la fin de la connexion dans le navigateur…',
  'No account yet': 'Pas encore de compte',
  'Add a Microsoft account that owns Minecraft: Java Edition to play.': 'Ajoutez un compte Microsoft qui possède Minecraft: Java Edition pour jouer.',
  'Playing as': 'Joue en tant que',
  Use: 'Utiliser',
  'A sign-in is already open.': 'Une connexion est déjà en cours.',
  // instances
  'New instance': 'Nouvelle instance',
  'Edit instance': 'Modifier l’instance',
  'Create instance': 'Créer l’instance',
  'Could not create the instance.': 'Impossible de créer l’instance.',
  'Instance settings': 'Paramètres de l’instance',
  Instance: 'Instance',
  Name: 'Nom',
  Memory: 'Mémoire',
  Save: 'Enregistrer',
  Cancel: 'Annuler',
  Close: 'Fermer',
  Delete: 'Supprimer',
  Duplicate: 'Dupliquer',
  More: 'Plus',
  Change: 'Changer',
  'Change picture': 'Changer l’image',
  'Use the default picture': 'Utiliser l’image par défaut',
  'Export as .mrpack': 'Exporter en .mrpack',
  'Import .mrpack': 'Importer un .mrpack',
  'Import modpack': 'Importer un modpack',
  'This deletes its worlds, mods and settings from your computer. It cannot be undone.': 'Cela supprime ses mondes, ses mods et ses réglages de votre ordinateur. C’est définitif.',
  'Fabric is installed, so mods work.': 'Fabric est installé : les mods fonctionnent.',
  'No Fabric for this version: it runs as plain Minecraft, and the Mods page is off.': 'Pas de Fabric pour cette version : le jeu tourne en Minecraft simple et la page Mods est désactivée.',
  "Azure Client is included, and Azure and Fabric API are locked (they can't be removed).": 'Azure Client est inclus ; Azure et Fabric API sont verrouillés (impossible de les retirer).',
  'Could not check which versions have Azure right now.': 'Impossible de vérifier pour l’instant quelles versions ont Azure.',
  'Minecraft version': 'Version de Minecraft',
  'Search versions, e.g. 1.20': 'Chercher une version, par ex. 1.20',
  'No version matches': 'Aucune version ne correspond',
  'Show snapshots': 'Afficher les snapshots',
  'Could not load versions': 'Impossible de charger les versions',
  Search: 'Rechercher',
  'Nothing found': 'Rien trouvé',
  'Not played yet': 'Pas encore joué',
  'Never played': 'Jamais joué',
  'Less than a minute': 'Moins d’une minute',
  'Last played today': 'Joué aujourd’hui',
  'Last played yesterday': 'Joué hier',
  'Last played last week': 'Joué la semaine dernière',
  'Something went wrong': 'Un problème est survenu',
  'Something went wrong.': 'Un problème est survenu.',
  'Keep at least one instance. Create another one first.': 'Gardez au moins une instance. Créez-en une autre d’abord.',
  'That instance no longer exists.': 'Cette instance n’existe plus.',
  'Give the instance a name.': 'Donnez un nom à l’instance.',
  'Names can be up to 40 characters.': 'Les noms font 40 caractères au maximum.',
  'Memory must be a number.': 'La mémoire doit être un nombre.',
  'Pick a Minecraft version.': 'Choisissez une version de Minecraft.',
  'Stop the game before deleting this instance.': 'Arrêtez le jeu avant de supprimer cette instance.',
  'Pick a .png, .jpg, .webp or .gif picture.': 'Choisissez une image .png, .jpg, .webp ou .gif.',
  'That file could not be read as a picture.': 'Ce fichier ne peut pas être lu comme une image.',
  'That picture is too big (over 20 MB).': 'Cette image est trop grande (plus de 20 Mo).',
  'That file could not be opened.': 'Ce fichier n’a pas pu être ouvert.',
  'Already running.': 'Déjà en cours.',
  // instance page
  Content: 'Contenu',
  Files: 'Fichiers',
  Worlds: 'Mondes',
  Logs: 'Journaux',
  'Upload files': 'Envoyer des fichiers',
  'Browse content': 'Parcourir le contenu',
  'Turned off first': 'Désactivés en premier',
  Refresh: 'Actualiser',
  Project: 'Projet',
  Version: 'Version',
  Actions: 'Actions',
  All: 'Tout',
  'Drop mods (.jar), resource packs or shader packs (.zip) here to add them.': 'Déposez ici des mods (.jar), des packs de ressources ou de shaders (.zip) pour les ajouter.',
  'Applies on restart': 'Appliqué au redémarrage',
  Undo: 'Annuler',
  'Nothing here yet. Use Browse content or drop files here.': 'Rien ici pour l’instant. Utilisez Parcourir le contenu ou déposez des fichiers ici.',
  'Included with Azure': 'Inclus avec Azure',
  'Uploaded file': 'Fichier envoyé',
  Folder: 'Dossier',
  'Added when the game starts': 'Ajouté au démarrage du jeu',
  'Show file': 'Afficher le fichier',
  'Open on Modrinth': 'Ouvrir sur Modrinth',
  'Everything is up to date': 'Tout est à jour',
  'Everything is up to date.': 'Tout est à jour.',
  Update: 'Mettre à jour',
  'Update all': 'Tout mettre à jour',
  'Instance folder': 'Dossier de l’instance',
  'Everything of this instance': 'Tout le contenu de cette instance',
  'Resource packs': 'Packs de ressources',
  'Shader packs': 'Packs de shaders',
  'Mod settings': 'Réglages des mods',
  Screenshots: 'Captures d’écran',
  Open: 'Ouvrir',
  'No worlds yet. Play this instance and create one.': 'Pas encore de monde. Jouez avec cette instance et créez-en un.',
  'Open logs folder': 'Ouvrir le dossier des journaux',
  'No log yet. It appears here after the game has started once.': 'Pas encore de journal. Il apparaît ici après un premier lancement du jeu.',
  'Updated.': 'Mis à jour.',
  // content (Modrinth)
  Modpacks: 'Modpacks',
  Mods: 'Mods',
  'Resource Packs': 'Packs de ressources',
  Shaders: 'Shaders',
  'No mods yet. Browse Modrinth to add some.': 'Pas encore de mods. Parcourez Modrinth pour en ajouter.',
  'No resource packs yet.': 'Pas encore de packs de ressources.',
  'No shader packs yet.': 'Pas encore de packs de shaders.',
  Relevance: 'Pertinence',
  Downloads: 'Téléchargements',
  Follows: 'Abonnés',
  Newest: 'Plus récents',
  Updated: 'Mis à jour',
  Browse: 'Parcourir',
  Installed: 'Installés',
  'Sort by': 'Trier par',
  Categories: 'Catégories',
  'Load more': 'Afficher plus',
  'Check for updates': 'Chercher des mises à jour',
  'Open folder': 'Ouvrir le dossier',
  'Creates a new instance': 'Crée une nouvelle instance',
  'Fabric modpacks': 'Modpacks Fabric',
  "Only Fabric modpacks are shown. Installing one creates a new instance with its Minecraft version, mods and settings; every file is checked against the pack's hashes.": 'Seuls les modpacks Fabric sont affichés. En installer un crée une nouvelle instance avec sa version de Minecraft, ses mods et ses réglages ; chaque fichier est vérifié avec les empreintes du pack.',
  'Shader packs need Iris (a mod that runs shaders). Install Iris from the Mods page, then add shader packs here.': 'Les packs de shaders ont besoin d’Iris (un mod qui fait tourner les shaders). Installez Iris depuis la page Mods, puis ajoutez des packs de shaders ici.',
  'Try again': 'Réessayer',
  'Searching Modrinth…': 'Recherche sur Modrinth…',
  "You're offline. Check your internet connection.": 'Vous êtes hors ligne. Vérifiez votre connexion internet.',
  "Can't reach Modrinth. Check your internet connection.": 'Modrinth est injoignable. Vérifiez votre connexion internet.',
  'Modrinth is busy right now. Try again in a minute.': 'Modrinth est surchargé. Réessayez dans une minute.',
  'Modrinth sent an answer that could not be read.': 'Modrinth a envoyé une réponse illisible.',
  'Nothing found for this version.': 'Rien trouvé pour cette version.',
  Install: 'Installer',
  'Installing…': 'Installation…',
  'Choose a picture…': 'Choisir une image…',
  'Choose a version': 'Choisir une version',
  'Creating…': 'Création…',
  'Importing…': 'Importation…',
  'Loading…': 'Chargement…',
  'Preparing…': 'Préparation…',
  'Starting…': 'Démarrage…',
  'Updating…': 'Mise à jour…',
  'Close the game and wait for downloads to finish before changing the game folder.': 'Fermez le jeu et attendez la fin des téléchargements avant de changer le dossier du jeu.',
  Release: 'Stable',
  Beta: 'Bêta',
  Alpha: 'Alpha',
  'Best is the newest release. Modpacks create a new instance.': 'Le mieux est la version stable la plus récente. Les modpacks créent une nouvelle instance.',
  'Show versions for other Minecraft versions too': 'Afficher aussi les versions pour d’autres versions de Minecraft',
  'Different Minecraft version': 'Autre version de Minecraft',
  'Install anyway': 'Installer quand même',
  'No versions found.': 'Aucune version trouvée.',
  Best: 'Recommandée',
  Latest: 'Dernière',
  'No safe download for this version': 'Pas de téléchargement sûr pour cette version',
  'Loading versions…': 'Chargement des versions…',
  Included: 'Inclus',
  Modrinth: 'Modrinth',
  'Local file': 'Fichier local',
  Off: 'Désactivé',
  'Turn off': 'Désactiver',
  'Turn on': 'Activer',
  Remove: 'Retirer',
  'The file is deleted from this instance.': 'Le fichier est supprimé de cette instance.',
  'Always on': 'Toujours actif',
  'Checking for updates…': 'Recherche de mises à jour…',
  'Add files': 'Ajouter des fichiers',
  'Add folder': 'Ajouter un dossier',
  'Drop .jar mods, .zip resource packs or shader packs here, or a folder. They are copied; your originals stay where they are.': 'Déposez ici des mods .jar, des packs de ressources ou de shaders .zip, ou un dossier. Ils sont copiés ; vos originaux restent où ils sont.',
  Mod: 'Mod',
  'Resource pack': 'Pack de ressources',
  'Shader pack': 'Pack de shaders',
  'Nothing to add: pick .jar mods or .zip packs.': 'Rien à ajouter : choisissez des mods .jar ou des packs .zip.',
  'These are copied into the selected instance. Nothing is run, and your originals are not touched.': 'Ils sont copiés dans l’instance choisie. Rien n’est exécuté et vos originaux ne sont pas modifiés.',
  'Found on Modrinth': 'Trouvé sur Modrinth',
  'Add anyway': 'Ajouter quand même',
  Add: 'Ajouter',
  OK: 'OK',
  'Downloading the modpack…': 'Téléchargement du modpack…',
  'Azure Client will be added by the launcher.': 'Azure Client sera ajouté par le launcher.',
  'Fabric does not support this Minecraft version yet.': 'Fabric ne prend pas encore en charge cette version de Minecraft.',
  Azure: 'Azure',
  Fabric: 'Fabric',
  Vanilla: 'Vanilla',
  Exported: 'Exporté',
  // mod check
  'Fabric did not start the game': 'Fabric n’a pas démarré le jeu',
  'Your mods are ready': 'Vos mods sont prêts',
  'One mod needs attention': 'Un mod demande votre attention',
  'Undo fixes': 'Annuler les corrections',
  'Putting your mods back': 'Remise en place de vos mods',
  'Fix all': 'Tout corriger',
  Fixing: 'Correction',
  'Play anyway': 'Jouer quand même',
  'The launcher adds this one itself, so it cannot be turned off here. Fix the other mods first.': 'Le launcher ajoute celui-ci lui-même, il ne peut donc pas être désactivé ici. Corrigez d’abord les autres mods.',
  'What Fabric says': 'Ce que dit Fabric',
  'Checking your mods': 'Vérification de vos mods',
  'Checking your account': 'Vérification de votre compte',
  'Checking for Azure updates': 'Recherche de mises à jour d’Azure',
  'Checking for Azure updates…': 'Recherche de mises à jour d’Azure…',
  'Restarting with your mod changes': 'Redémarrage avec vos changements de mods',
  'Wait until the download or fix in progress is done.': 'Attendez la fin du téléchargement ou de la correction en cours.',
  // settings
  'Memory for the game': 'Mémoire pour le jeu',
  'More memory helps big modpacks. Too much can slow the game down; 2–4 GB is right for most.': 'Plus de mémoire aide les gros modpacks. Trop peut ralentir le jeu ; 2 à 4 Go conviennent dans la plupart des cas.',
  'Java arguments': 'Arguments Java',
  "Extra options for the game's Java. Leave empty unless you know you need them.": 'Options supplémentaires pour le Java du jeu. Laissez vide sauf si vous savez en avoir besoin.',
  'e.g. -XX:+UseZGC': 'par ex. -XX:+UseZGC',
  'Game folder': 'Dossier du jeu',
  'Change…': 'Changer…',
  'Use default': 'Par défaut',
  'Minecraft files, Java and your instances live here. Changing it does not move what is already there.': 'Les fichiers de Minecraft, Java et vos instances sont ici. Le changer ne déplace pas ce qui s’y trouve déjà.',
  'Launcher updates': 'Mises à jour du launcher',
  'Restart to update': 'Redémarrer pour mettre à jour',
  'Update the launcher automatically (it reopens by itself in a few seconds, never while you play)': 'Mettre à jour le launcher automatiquement (il se rouvre seul en quelques secondes, jamais pendant que vous jouez)',
  'Hide the launcher while the game is running': 'Cacher le launcher pendant que le jeu tourne',
  'Open the logs when the game launches': 'Ouvrir les journaux au lancement du jeu',
  Language: 'Langue',
  'Language of the launcher. "Same as Windows" follows your system language.': 'Langue du launcher. « Comme Windows » suit la langue de votre système.',
  'Same as Windows': 'Comme Windows',
  English: 'English',
  Français: 'Français',
  About: 'À propos',
  Notice: 'Avertissement',
  'Azure Launcher is not an official Minecraft product. It is not approved by or associated with Mojang or Microsoft.': 'Azure Launcher n’est pas un produit officiel Minecraft. Il n’est ni approuvé par Mojang ou Microsoft, ni associé à eux.',
  Publisher: 'Éditeur',
  Contact: 'Contact',
  Privacy: 'Confidentialité',
  'Your sign-in is stored encrypted on this PC and is never sent to our servers.': 'Votre connexion est enregistrée chiffrée sur ce PC et n’est jamais envoyée à nos serveurs.',
  'Privacy page': 'Page de confidentialité',
  'Open-source licenses': 'Licences open source',
  'Licenses of bundled software': 'Licences des logiciels inclus',
  Electron: 'Electron',
  Chromium: 'Chromium',
  Clear: 'Effacer',
  'You have the latest launcher.': 'Vous avez la dernière version du launcher.',
  "Couldn't update the launcher. This version keeps working; it will try again later.": 'Impossible de mettre à jour le launcher. Cette version continue de fonctionner ; nouvel essai plus tard.',
  'Updates are off in a development build.': 'Les mises à jour sont désactivées dans une version de développement.',
  'Launcher updates are not set up yet.': 'Les mises à jour du launcher ne sont pas encore configurées.',
  'Close the game (and wait for downloads) first, then update.': 'Fermez d’abord le jeu (et attendez la fin des téléchargements), puis mettez à jour.',
  // messages from app/messages.js
  "Sign-in isn't available yet.": 'La connexion n’est pas encore disponible.',
  "Microsoft signed you in, but Minecraft hasn't approved Azure Launcher yet, so you can't play with it for now. Nothing is wrong with your account. Please try again later.": 'Microsoft vous a connecté, mais Minecraft n’a pas encore approuvé Azure Launcher : vous ne pouvez pas jouer avec pour l’instant. Votre compte n’a aucun problème. Réessayez plus tard.',
  "This Microsoft account doesn't own Minecraft: Java Edition.": 'Ce compte Microsoft ne possède pas Minecraft: Java Edition.',
  'Finish setting up your Minecraft profile in the official Minecraft Launcher first, then try again.': 'Terminez d’abord la création de votre profil Minecraft dans le launcher officiel, puis réessayez.',
  'This account needs an Xbox profile. Sign in once at xbox.com, then try again.': 'Ce compte a besoin d’un profil Xbox. Connectez-vous une fois sur xbox.com, puis réessayez.',
  "Xbox doesn't allow this account to sign in (a child account, or Xbox isn't available in your country).": 'Xbox n’autorise pas ce compte à se connecter (compte enfant, ou Xbox indisponible dans votre pays).',
  'Please sign in again.': 'Veuillez vous reconnecter.',
  'Sign-in was cancelled or timed out. Try again.': 'La connexion a été annulée ou a expiré. Réessayez.',
  "Can't reach Microsoft or Minecraft. Check your internet connection.": 'Microsoft ou Minecraft est injoignable. Vérifiez votre connexion internet.',
  "The game couldn't start.": 'Le jeu n’a pas pu démarrer.',
  "Windows couldn't open your saved sign-in on this PC (its secure storage isn't available). Restart the PC and open the launcher again; if it keeps happening, sign in again.": 'Windows n’a pas pu ouvrir votre connexion enregistrée sur ce PC (son stockage sécurisé est indisponible). Redémarrez le PC et rouvrez le launcher ; si cela continue, reconnectez-vous.',
  'There isn\'t enough free space on the disk. Free up some space (a few GB), then press Play again.': 'Il n’y a pas assez d’espace libre sur le disque. Libérez de la place (quelques Go), puis cliquez de nouveau sur Jouer.',
  'A game file is in use by another program (often the game itself, or a virus scanner). Close the game, wait a moment, then press Play again.': 'Un fichier du jeu est utilisé par un autre programme (souvent le jeu lui-même ou un antivirus). Fermez le jeu, attendez un instant, puis cliquez de nouveau sur Jouer.',
  "Azure Launcher isn't allowed to write to the game folder. Choose another game folder in Settings, or check the folder's permissions.": 'Azure Launcher n’a pas le droit d’écrire dans le dossier du jeu. Choisissez un autre dossier dans Paramètres, ou vérifiez les autorisations du dossier.',
  "A download didn't finish. Check your internet connection, then press Play again: what is already downloaded is kept.": 'Un téléchargement n’a pas abouti. Vérifiez votre connexion internet, puis cliquez de nouveau sur Jouer : ce qui est déjà téléchargé est conservé.',
  'A downloaded file was damaged and has been thrown away. Press Play again to download it again.': 'Un fichier téléchargé était endommagé et a été supprimé. Cliquez de nouveau sur Jouer pour le retélécharger.',
  "Mojang's or Fabric's download servers aren't answering right now. Try again in a few minutes.": 'Les serveurs de téléchargement de Mojang ou de Fabric ne répondent pas pour l’instant. Réessayez dans quelques minutes.',
  "This Minecraft version (or its Fabric version) can't be downloaded. Pick another version for this instance.": 'Cette version de Minecraft (ou sa version Fabric) ne peut pas être téléchargée. Choisissez une autre version pour cette instance.',
  // fix labels and reasons (src/modfix.js, src/mrpack.js)
  'Azure Client and Fabric API are managed by the launcher': 'Azure Client et Fabric API sont gérés par le launcher',
  'Azure Client is added by the launcher': 'Azure Client est ajouté par le launcher',
  'no SHA-512 hash': 'pas d’empreinte SHA-512',
  'no download from an allowed host': 'pas de téléchargement depuis un site autorisé',
  'not a mod, pack or config file': 'ni un mod, ni un pack, ni un fichier de configuration',
  'not allowed': 'non autorisé',
  'unsafe path': 'chemin dangereux',
  mod: 'mod',
  'resource pack': 'pack de ressources',
  'shader pack': 'pack de shaders',
};

// Words inside patterns: the kinds of content.
const KIND = { mods: 'mods', modpacks: 'modpacks', 'resource packs': 'packs de ressources', shaders: 'shaders', mod: 'mod', 'resource pack': 'pack de ressources', 'shader pack': 'pack de shaders' };
const plural = (n, one, many) => (Number(n) === 1 ? one : many);

// [regex on the whole text, replacement function]. Groups that are themselves English text go through tr() again.
const PATTERNS = [
  [/^by (.+)$/, (m, a) => 'par ' + a],
  [/^([\d.,]+[KM]?) downloads$/, (m, n) => n.replace('.', ',') + ' téléchargements'],
  [/^Install (.+)$/, (m, n) => 'Installer ' + n],
  [/^Choose a version of (.+)$/, (m, n) => 'Choisir une version de ' + n],
  [/^Search (.+) on Modrinth$/, (m, k) => 'Rechercher des ' + (KIND[k] || k) + ' sur Modrinth'],
  [/^Search (\d+) projects…$/, (m, n) => 'Rechercher parmi ' + n + ' projets…'],
  [/^Mods are off for this instance: Minecraft (\S+) has no Fabric, so it runs as plain Minecraft\. Pick or create an instance on a Fabric version to use mods\.$/,
    (m, v) => 'Les mods sont désactivés pour cette instance : Minecraft ' + v + ' n’a pas de Fabric, il tourne donc en Minecraft simple. Choisissez ou créez une instance sur une version avec Fabric pour utiliser des mods.'],
  [/^No results for “(.*)” on Minecraft (\S+)\.$/, (m, q, v) => 'Aucun résultat pour « ' + q + ' » sur Minecraft ' + v + '.'],
  [/^Installed (.+?) \(with (\d+) required mods?\)$/, (m, what, n) => what + ' installé (avec ' + n + ' ' + plural(n, 'mod requis', 'mods requis') + ')'],
  [/^Installed (.+)$/, (m, what) => what + ' installé'],
  [/^Installing (.+)…$/, (m, what) => 'Installation de ' + what + '…'],
  [/^Installing (\d+)%$/, (m, n) => 'Installation ' + n + ' %'],
  [/^Could not install (.+)$/, (m, what) => 'Impossible d’installer ' + what],
  [/^Best is the newest release made for Minecraft (\S+)( and Fabric)?\.$/, (m, v, f) => 'Le mieux est la version stable la plus récente pour Minecraft ' + v + (f ? ' et Fabric' : '') + '.'],
  [/^(.+) is made for Minecraft (.+), not (\S+)\. It may not work\.$/, (m, n, vs, v) => n + ' est fait pour Minecraft ' + (vs === 'another version' ? 'une autre version' : vs) + ', pas ' + v + '. Il risque de ne pas fonctionner.'],
  [/^No versions found for Minecraft (\S+)\. Try showing versions for other Minecraft versions\.$/, (m, v) => 'Aucune version trouvée pour Minecraft ' + v + '. Essayez d’afficher les versions pour d’autres versions de Minecraft.'],
  [/^For (.+)$/, (m, v) => 'Pour ' + (v === 'another version' ? 'une autre version' : v)],
  [/^Update to (.+)$/, (m, v) => 'Mettre à jour vers ' + v],
  [/^Remove “(.*)”\?$/, (m, n) => 'Retirer « ' + n + ' » ?'],
  [/^Delete “(.*)”\?$/, (m, n) => 'Supprimer « ' + n + ' » ?'],
  [/^Nothing matches “(.*)”\.$/, (m, q) => 'Rien ne correspond à « ' + q + ' ».'],
  [/^Updated (\d+) items?\.?$/, (m, n) => plural(n, '1 élément mis à jour', n + ' éléments mis à jour')],
  [/^Updated (.+)$/, (m, n) => n + ' mis à jour'],
  [/^Update all \((\d+)\)$/, (m, n) => 'Tout mettre à jour (' + n + ')'],
  [/^(\d+) updates? available$/, (m, n) => n + ' ' + plural(n, 'mise à jour disponible', 'mises à jour disponibles')],
  [/^(\d+) of (\d+) will be added$/, (m, a, b) => a + ' sur ' + b + ' ' + plural(a, 'sera ajouté', 'seront ajoutés')],
  [/^Added (\d+) files?(?: · skipped (\d+))?$/, (m, n, s) => plural(n, '1 fichier ajouté', n + ' fichiers ajoutés') + (s ? ' · ' + s + ' ignoré' + (Number(s) === 1 ? '' : 's') : '')],
  [/^Last played (\d+) days ago$/, (m, n) => 'Joué il y a ' + n + ' jours'],
  [/^Last played (\d+) weeks ago$/, (m, n) => 'Joué il y a ' + n + ' semaines'],
  [/^Last played (.+)$/, (m, d) => 'Joué le ' + d],
  [/^Played (.+)$/, (m, d) => 'Joué le ' + d],
  [/^Default \((.+)\)$/, (m, g) => 'Par défaut (' + g.replace(' GB', ' Go') + ')'],
  [/^Use the launcher's default \((.+)\)$/, (m, g) => 'Utiliser la valeur du launcher (' + g.replace(' GB', ' Go') + ')'],
  [/^Memory: (.+?)  ·  (.+)$/, (m, a, b) => 'Mémoire : ' + tr(a) + '  ·  ' + tr(b)],
  [/^([\d.]+) GB$/, (m, n) => n.replace('.', ',') + ' Go'],
  [/^(\d+) mods need attention$/, (m, n) => n + ' mods demandent votre attention'],
  [/^(Fabric refused this set of mods, so the game closed\.|Nothing left that would stop the game\.|These would stop the game from starting, so it was not started\.) (.*): Minecraft (\S+), Fabric Loader (\S+)\.$/,
    (m, a, n, v, l) => ({
      'Fabric refused this set of mods, so the game closed.': 'Fabric a refusé cet ensemble de mods, le jeu s’est donc fermé.',
      'Nothing left that would stop the game.': 'Plus rien n’empêche le jeu de démarrer.',
      'These would stop the game from starting, so it was not started.': 'Ces mods empêcheraient le jeu de démarrer, il n’a donc pas été lancé.',
    })[a] + ' ' + n + ' : Minecraft ' + v + ', Fabric Loader ' + l + '.'],
  [/^Made for Minecraft (.+); this instance is (\S+)\.$/, (m, s, v) => 'Fait pour Minecraft ' + s + ' ; cette instance est en ' + v + '.'],
  [/^Needs Fabric Loader (.+); this instance has (\S+)\.$/, (m, s, v) => 'Demande Fabric Loader ' + s + ' ; cette instance a ' + v + '.'],
  [/^Needs Java (.+); Minecraft (\S+) runs on Java (\S+)\.$/, (m, s, v, j) => 'Demande Java ' + s + ' ; Minecraft ' + v + ' tourne avec Java ' + j + '.'],
  [/^Needs (.+), which is not installed\.$/, (m, d) => 'Demande ' + d + ', qui n’est pas installé.'],
  [/^Needs (.+); you have (.+)\.$/, (m, d, v) => 'Demande ' + d + ' ; vous avez ' + v + '.'],
  [/^Does not work together with (.+), its author says\.$/, (m, d) => 'Ne fonctionne pas avec ' + d + ', selon son auteur.'],
  [/^Installed twice: (.+) is the copy that stays\.$/, (m, f) => 'Installé deux fois : ' + f + ' est la copie gardée.'],
  [/^Get the version for (\S+) \((.+)\)$/, (m, v, n) => 'Prendre la version pour ' + v + ' (' + n + ')'],
  [/^Use Fabric Loader (.+)$/, (m, v) => 'Utiliser Fabric Loader ' + v],
  [/^Get (.+)$/, (m, d) => 'Obtenir ' + d],
  [/^Downloading (.+) \((\d+)\/(\d+)\)$/, (m, f, a, b) => 'Téléchargement de ' + f + ' (' + a + '/' + b + ')'],
  [/^Updating (.+) \((\d+)\/(\d+)\)$/, (m, f, a, b) => 'Mise à jour de ' + f + ' (' + a + '/' + b + ')'],
  [/^Downloading (.+)…$/, (m, v) => 'Téléchargement de ' + v + '…'],
  [/^Updating to (.+)…$/, (m, v) => 'Mise à jour vers ' + v + '…'],
  [/^Launcher (\S+) is ready\. It installs by itself when nothing is running\.$/, (m, v) => 'Le launcher ' + v + ' est prêt. Il s’installe tout seul quand rien ne tourne.'],
  [/^Launcher (\S+) is ready\. It installs when you restart\.$/, (m, v) => 'Le launcher ' + v + ' est prêt. Il s’installe au redémarrage.'],
  [/^Launcher updated to (.+)\.$/, (m, v) => 'Launcher mis à jour vers ' + v + '.'],
  [/^Version (\S*) · (.+)$/, (m, v, rest) => 'Version ' + v + ' · ' + tr(rest)],
  [/^(.+) crashed the game: rolled back, starting again$/, (m, w) => w + ' a fait planter le jeu : changement annulé, nouveau démarrage'],
  [/^Saved (\d+) mods and packs as download links(?: and (\d+) files inside the pack)?\. Azure Client is not included: the launcher adds it itself\.$/,
    (m, a, b) => a + ' mods et packs enregistrés comme liens de téléchargement' + (b ? ' et ' + b + ' fichiers dans le pack' : '') + '. Azure Client n’est pas inclus : le launcher l’ajoute lui-même.'],
  [/^(\d+) files to download, each checked against the pack's hashes\.$/, (m, n) => n + ' fichiers à télécharger, chacun vérifié avec les empreintes du pack.'],
  [/^(\d+) entries are skipped \(not allowed\)\.$/, (m, n) => n + ' entrées ignorées (non autorisées).'],
  [/^(.+) · (Uploaded file|Modrinth|Local file|Included with Azure|Folder|Added when the game starts)$/, (m, k, src) => tr(k) + ' · ' + tr(src)],
];

function tr(text) {
  if (lang !== 'fr') return text;
  const s = String(text);
  const core = s.trim();
  if (!core) return s;
  let out = Object.prototype.hasOwnProperty.call(FR, core) ? FR[core] : null;
  if (out == null) {
    for (const [re, fn] of PATTERNS) {
      const m = core.match(re);
      if (m) { out = fn(...m); break; }
    }
  }
  if (out == null) return s;
  const lead = s.slice(0, s.indexOf(core));
  return lead + out + s.slice(lead.length + core.length);
}

// ---------- applying it to the page ----------
const ATTRS = ['placeholder', 'title', 'aria-label'];
const original = new WeakMap(); // node -> its English text (text nodes) or { attr: English } (elements)
let lang = 'en';
let observer = null;
let started = false;

function skip(node) {
  const e = node.nodeType === 1 ? node : node.parentElement;
  return !e || !!e.closest('[data-raw], script, style, textarea, pre, code');
}

function applyText(node) {
  if (skip(node)) return;
  const prev = original.get(node);
  const shown = node.nodeValue;
  // the page wrote new English text into this node since we last translated it
  const en = prev && (shown === prev.fr) ? prev.en : shown;
  const fr = tr(en);
  original.set(node, { en, fr });
  if (fr !== shown) node.nodeValue = fr;
}

function applyAttrs(el) {
  if (skip(el)) return;
  let rec = original.get(el);
  if (!rec) { rec = {}; original.set(el, rec); }
  for (const a of ATTRS) {
    if (!el.hasAttribute(a)) continue;
    const shown = el.getAttribute(a);
    const prev = rec[a];
    const en = prev && shown === prev.fr ? prev.en : shown;
    const fr = tr(en);
    rec[a] = { en, fr };
    if (fr !== shown) el.setAttribute(a, fr);
  }
}

function walk(root) {
  if (root.nodeType === 3) { applyText(root); return; }
  if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
  if (root.nodeType === 1) applyAttrs(root);
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (n.nodeType === 3) applyText(n); else applyAttrs(n);
  }
}

/** Dates in the launcher's language: French, or the system's own format (en-GB, de-DE...) otherwise. */
function setDateLocale() {
  window.AZURE_UI_LANG = lang === 'fr' ? 'fr-FR' : (navigator.language || 'en');
  if (typeof UI_LANG !== 'undefined') window.UI_LANG = window.AZURE_UI_LANG;
}

function resolve(choice) {
  if (choice === 'fr' || choice === 'en') return choice;
  return /^fr\b/i.test(navigator.language || '') ? 'fr' : 'en';
}

/** Sets the language ('system' | 'en' | 'fr') and translates (or restores) everything on the page. */
function setLanguage(choice) {
  const next = resolve(choice);
  try { localStorage.setItem('azure.lang', choice || 'system'); } catch { /* only a start-up hint */ }
  if (next === lang && (observer || lang === 'en') && started) return;
  started = true;
  lang = next;
  setDateLocale();
  document.documentElement.lang = lang;
  if (observer) observer.disconnect();
  walk(document.body || document.documentElement); // in English this puts the English texts back
  if (lang === 'en') { observer = null; return; } // nothing to translate: no work on every change
  observer = new MutationObserver((list) => {
    observer.disconnect();
    for (const m of list) {
      if (m.type === 'childList') m.addedNodes.forEach(walk);
      else if (m.type === 'characterData') applyText(m.target);
      else if (m.type === 'attributes') applyAttrs(m.target);
    }
    observe();
  });
  observe();
}

function observe() {
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

// Before the other scripts run: the language picked last time (or the system's), so dates and the first paint match.
if (typeof document !== 'undefined') {
  let startChoice = 'system';
  try { startChoice = localStorage.getItem('azure.lang') || 'system'; } catch { /* none */ }
  lang = resolve(startChoice);
  setDateLocale();
  document.documentElement.lang = lang;
  document.addEventListener('DOMContentLoaded', () => { lang = 'en'; setLanguage(startChoice); });
}

// For tests (Node): the dictionary and the text function.
if (typeof module !== 'undefined') module.exports = { FR, PATTERNS, tr: (t, l = 'fr') => { const was = lang; lang = l; try { return tr(t); } finally { lang = was; } } };
