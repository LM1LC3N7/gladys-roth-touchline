// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, button, device and feature names,
// refusals of a command), in English and French.
// -----------------------------------------------------------------------------

import { FEATURES as F } from './constants.js';

/** The text of `texts` in `language`, English otherwise. */
export const word = (texts, language) => texts[language] ?? texts.en;

export const both = (en, fr) => ({ en, fr });

/** Two messages one after the other, in each language. */
export const join = (...messages) =>
  both(messages.map((m) => m.en).join(' '), messages.map((m) => m.fr).join(' '));

/** "45 s" / "25 min" / "3 h", for the waits (59.99 s is "1 min", never "60 s"). */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const FEATURE_NAMES = {
  [F.TEMPERATURE]: both('Temperature', 'Température'),
  [F.TARGET]: both('Setpoint', 'Consigne'),
  [F.MODE]: both('Mode', 'Mode'),
  [F.PROGRAM]: both('Week program', 'Programme hebdomadaire'),
};

export const MODE_NAMES = {
  normal: both('Normal', 'Normal'),
  night: both('Night', 'Nuit'),
  holiday: both('Holiday', 'Vacances'),
};

export const PROGRAM_NAMES = {
  none: both('None (mode applies)', 'Aucun (le mode s’applique)'),
  'program-1': both('Program 1', 'Programme 1'),
  'program-2': both('Program 2', 'Programme 2'),
  'program-3': both('Program 3', 'Programme 3'),
};

/** "Living room (Touchline)" / "Device 3 (Touchline)". */
export const deviceName = (name, index) =>
  name
    ? both(`${name} (Touchline)`, `${name} (Touchline)`)
    : both(`Device ${index + 1} (Touchline)`, `Appareil ${index + 1} (Touchline)`);

/** The reason of a failure, in each language. */
export function reasonOf(err) {
  const status = err?.status ? ` (HTTP ${err.status})` : '';
  switch (err?.code) {
    case 'timeout':
      return both('no answer in time', 'pas de réponse à temps');
    case 'network':
      return both(
        'the controller cannot be reached on the network',
        'le régulateur est injoignable sur le réseau',
      );
    case 'http':
      return both(
        `the controller answered an error${status}`,
        `le régulateur a répondu une erreur${status}`,
      );
    case 'bad_response':
    case 'empty':
    case 'size':
    case 'too_many':
      return both('the answer is not the expected one', "la réponse n'est pas celle attendue");
    default:
      return both('unexpected error', 'erreur inattendue');
  }
}

export const T = {
  noConfig: both(
    'Enter the IP address of the Touchline controller.',
    "Saisissez l'adresse IP du régulateur Touchline.",
  ),
  addressPath: both(
    'The address field holds a path or credentials: enter only the IP address (and the port).',
    "Le champ adresse contient un chemin ou des identifiants : saisissez seulement l'adresse IP (et le port).",
  ),
  addressHttps: both(
    'Enter the address without "https://": the controller answers over http on your local network.',
    "Saisissez l'adresse sans « https:// » : le régulateur répond en http sur votre réseau local.",
  ),
  addressInvalid: both(
    'The address is not a valid IP address or host name.',
    "L'adresse n'est pas une adresse IP ou un nom d'hôte valide.",
  ),
  connecting: both('Reading the controller…', 'Lecture du régulateur…'),
  connected: (read, total) =>
    both(
      `Connected: ${read}/${total} device${total > 1 ? 's' : ''} read.`,
      `Connecté : ${read}/${total} appareil${total > 1 ? 's' : ''} lu${read > 1 ? 's' : ''}.`,
    ),
  noDevice: both(
    'The controller knows no device (no room thermostat is paired).',
    "Le régulateur ne connaît aucun appareil (aucun thermostat d'ambiance n'est appairé).",
  ),
  unreadDevices: (list) => both(`Not read: ${list}.`, `Non lus : ${list}.`),
  andMore: (n) => both(` and ${n} more`, ` et ${n} autres`),
  configNotRead: (wait) =>
    both(
      `The configuration of Gladys could not be read yet. New try in ${wait.en}.`,
      `La configuration de Gladys n'a pas encore pu être lue. Nouvel essai dans ${wait.fr}.`,
    ),
  notApplied: (list) =>
    both(
      `Command without effect: ${list.en} (the controller echoed the value, the read back differs).`,
      `Commande sans effet : ${list.fr} (le régulateur a renvoyé la valeur, la relecture diffère).`,
    ),
  unreachable: (reason, wait) =>
    both(
      `Controller not read: ${reason.en}. New try in ${wait.en}.`,
      `Régulateur non lu : ${reason.fr}. Nouvel essai dans ${wait.fr}.`,
    ),
  test: {
    wait: (wait) =>
      both(
        `A read just ran: next one possible in ${wait.en}.`,
        `Une lecture vient d'avoir lieu : prochaine possible dans ${wait.fr}.`,
      ),
    busy: both(
      'A read is in progress, try again in a few seconds.',
      'Une lecture est en cours, réessayez dans quelques secondes.',
    ),
    slow: both(
      'The read is still running; the status will follow.',
      "La lecture est toujours en cours ; l'état suivra.",
    ),
  },
};

export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  configNotLoaded: both(
    'The configuration of the integration is not loaded yet: command not sent.',
    'La configuration de l’intégration n’est pas encore chargée : commande non envoyée.',
  ),
  queueFull: (n) =>
    both(
      `${n} commands are already waiting: command not sent.`,
      `${n} commandes attendent déjà : commande non envoyée.`,
    ),
  queueLate: (n) =>
    both(
      `Not sent in time: ${n} command(s) were waiting before it (wait about 4 s between two rooms).`,
      `Non envoyée à temps : ${n} commande(s) attendaient avant elle (laissez environ 4 s entre deux pièces).`,
    ),
  notSent: (reason) =>
    both(`Command not sent: ${reason.en}.`, `Commande non envoyée : ${reason.fr}.`),
  verifyLater: both(
    'Command sent and echoed by the controller: checked by a read in a few seconds.',
    'Commande envoyée et renvoyée par le régulateur : vérification par une relecture dans quelques secondes.',
  ),
  notAppliedNow: (read, written) =>
    both(
      `The controller echoed the value but the read back gives ${read.en} instead of ${written.en}.`,
      `Le régulateur a renvoyé la valeur mais la relecture donne ${read.fr} au lieu de ${written.fr}.`,
    ),
  minAboveCeiling: (min, ceiling) =>
    both(
      `The minimum of this room (${min} °C) is above the setpoint ceiling (${ceiling} °C): raise the ceiling in the configuration. Command not sent.`,
      `Le minimum de cette pièce (${String(min).replace('.', ',')} °C) dépasse le plafond des consignes (${ceiling} °C) : relevez le plafond dans la configuration. Commande non envoyée.`,
    ),
  inconsistentLimits: both(
    'The setpoint limits of the device are inconsistent (minimum above maximum): command not sent.',
    'Les limites de consigne de l’appareil sont incohérentes (minimum au-dessus du maximum) : commande non envoyée.',
  ),
  noDeviceAtPosition: both(
    'No thermostat answers at the position of this device now (re-run a scan): command not sent.',
    'Aucun thermostat ne répond à la position de cet appareil (relancez une recherche) : commande non envoyée.',
  ),
  setpointsDisabled: both(
    'Setpoint commands are off: allow them in the configuration of the integration.',
    'Les commandes de consigne sont désactivées : autorisez-les dans la configuration de l’intégration.',
  ),
  modesDisabled: both(
    'Mode and program commands are off: allow them in the configuration of the integration.',
    'Les commandes de mode et de programme sont désactivées : autorisez-les dans la configuration de l’intégration.',
  ),
  badNumber: both('Not a temperature.', 'Ce n’est pas une température.'),
  badStep: both('Use steps of 0.1 °C.', 'Utilisez des pas de 0,1 °C.'),
  outOfRange: (min, max) =>
    both(
      `Setpoint refused: from ${min} to ${max} °C only.`,
      `Consigne refusée : de ${min} à ${max} °C seulement.`,
    ),
  badOption: both('Unknown mode or program.', 'Mode ou programme inconnu.'),
  stillRunning: both(
    'Another command is still running: try again in a few seconds.',
    'Une autre commande est en cours : réessayez dans quelques secondes.',
  ),
  paused: both(
    'The controller is paused after failed reads: command not sent.',
    'Le régulateur est en pause après des lectures en échec : commande non envoyée.',
  ),
  unknownDevice: both(
    'This device is not known now: command not sent.',
    'Cet appareil n’est pas connu pour l’instant : commande non envoyée.',
  ),
  otherDevice: both(
    'Another device answers at this position now (re-run a scan): command not sent.',
    'Un autre appareil répond à cette position (relancez une recherche) : commande non envoyée.',
  ),
  tooSlow: both(
    'The controller answers too slowly: command not sent.',
    'Le régulateur répond trop lentement : commande non envoyée.',
  ),
  busy: both(
    'A read of the controller was running and the controller answered too slowly: command not sent.',
    'Une lecture du régulateur était en cours et le régulateur a répondu trop lentement : commande non envoyée.',
  ),
  unknownState: (reason) =>
    both(
      `The current state could not be read (${reason.en}): command not sent.`,
      `L’état actuel n’a pas pu être lu (${reason.fr}) : commande non envoyée.`,
    ),
  missingLimits: both(
    'The setpoint limits of the device could not be read: command not sent.',
    'Les limites de consigne de l’appareil n’ont pas pu être lues : commande non envoyée.',
  ),
  unconfirmed: both(
    'Command sent, without confirmation (no echo in time): the device is read again in a few seconds.',
    'Commande envoyée, sans confirmation (pas de renvoi à temps) : l’appareil est relu dans quelques secondes.',
  ),
  refusedByController: both(
    'The controller refused the command.',
    'Le régulateur a refusé la commande.',
  ),
};
