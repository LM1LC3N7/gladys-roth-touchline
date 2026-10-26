# Roth Touchline pour Gladys

Cette intégration affiche les pièces (thermostats d'ambiance) de votre plancher
chauffant **Roth Touchline** dans Gladys, par le **régulateur Ethernet
Touchline** branché sur votre réseau local. Elle lui parle directement, sans
compte ni mot de passe, par les deux scripts CGI que le régulateur expose
(lecture et écriture de valeurs).

**Ce n'est pas Touchline SL** : Touchline SL est la gamme plus récente de Roth,
pilotée par un service cloud avec un compte Roth ; elle a sa propre
intégration (« Roth Touchline SL »). Si votre application Roth vous demande
un compte, c'est Touchline SL.

**Jamais testé avec un vrai appareil** : elle suit la bibliothèque
pytouchline_extended (celle de l'intégration Home Assistant `touchline`),
sans avoir pu être essayée sur une installation réelle. Dites-nous sur le
forum si elle fonctionne chez vous. **Sans lien avec Roth.**

## Ce qu'elle fait

Pour chaque pièce connue du régulateur, un appareil « Nom de la pièce
(Touchline) » avec :

- la température de la pièce (lecture seule) ;
- la consigne (thermostat) ;
- le mode : normal, nuit ou vacances (liste) ;
- le programme hebdomadaire : aucun, 1, 2 ou 3 (liste).

Quand un programme est actif, c'est lui qui décide du mode au fil de la
journée ; « aucun » laisse le mode choisi s'appliquer en permanence.

## Installation

1. Installez l'intégration depuis le store de Gladys.
2. Saisissez l'adresse IP du régulateur Touchline (celle de son interface
   web), puis enregistrez.
3. Ouvrez l'onglet **Découverte** et ajoutez les pièces voulues.

Le bouton **Tester la connexion** lit le régulateur une fois, si l'intervalle
de rafraîchissement le permet, et affiche son état.

Les appareils sont identifiés par les deux numéros que le régulateur donne à
chaque thermostat (celui du régulateur et celui du thermostat), pas par leur
position dans la liste : retirer un thermostat ne mélange pas les autres. Un
thermostat dont ces numéros ne se lisent pas n'est pas proposé.

## Commandes (désactivées par défaut)

Par défaut, Gladys ne fait que lire. Deux options séparées :

- **Autoriser les commandes de consigne** : le tableau de bord, les scènes et
  les assistants vocaux peuvent changer la consigne d'une pièce.
- **Autoriser les commandes de mode et de programme** : les listes « Mode »
  et « Programme hebdomadaire » peuvent être changées depuis Gladys.

Bornes de sécurité :

- une consigne va de 5 °C au **plafond des consignes**, **24 °C par défaut**,
  réglable de 16 à 30 °C ; les **limites du régulateur** lui-même (minimum
  et maximum réglés pour la pièce) s'appliquent aussi, et ne sont jamais
  modifiées par Gladys ;
- le plafond, l'option et les limites sont revérifiés juste avant l'envoi :
  si l'un d'eux a changé pendant la commande, rien ne part ;
- aucune commande ne passe par un interrupteur : un « éteins tout » d'un
  assistant vocal ne touche pas le chauffage. Le régulateur Touchline n'a pas
  de commande d'arrêt du chauffage : baisser la consigne ou passer en mode
  vacances sont des commandes comme les autres, soumises aux mêmes options.

Chaque commande relit la pièce juste avant d'agir, vérifie que c'est bien le
thermostat visé qui répond à cette position, et décide sur cette lecture ;
elle part dans les 3,5 s ou est refusée sans rien envoyer. Le régulateur
renvoie la valeur écrite : c'est la confirmation. S'il ne la renvoie pas à
temps, Gladys affiche « envoyée, sans confirmation » et relit la pièce 5 s et
20 s plus tard. Une commande à la fois, espacées de 3 s (le régulateur est
lent).

Une commande est refusée, sans rien envoyer, dans ces cas : option
désactivée ; valeur hors bornes, pas au dixième de degré, ou mode/programme
inconnu ; pièce inconnue ou autre thermostat à sa position ; lecture du
régulateur en pause après des échecs ; régulateur trop lent ; limites de
consigne illisibles ; autre commande en cours ou trop récente.

## Limites et sécurité

- Lecture toutes les 60 s (de 30 s à 10 min), toutes les pièces à la suite,
  une requête à la fois ; une pièce qui ne répond pas laisse les autres se
  lire ; une lecture n'entame plus de nouvelle pièce passé 45 s, le reste
  attend la suivante. Jamais deux lectures à moins d'un intervalle, même après un
  redémarrage (l'heure de la dernière tentative est gardée dans `/data`).
- Régulateur injoignable : pause de 1, 2, 5, 10 puis 15 min (jamais moins
  que l'intervalle), gardée dans `/data`, pour les lectures, le bouton et
  les commandes.
- `/data` ne contient ni l'adresse du régulateur ni aucun secret (il n'y en a
  pas) : seulement l'heure de la dernière tentative, la pause et l'heure de
  la dernière écriture, rattachées à une empreinte de l'adresse.
- Le régulateur expose son mot de passe d'interface (`CD.upass`) à qui le lui
  demande : l'intégration ne le demande jamais.
- La requête de lecture s'identifie comme « gladys-roth-touchline », pas comme
  le logiciel Roth. Si votre régulateur n'y répond pas, dites-le sur le forum.
- 32 pièces au plus par régulateur.

## Crédits

Le protocole du régulateur et la forme de ses réponses viennent de
[pytouchline_extended](https://github.com/brondum/pytouchline) (brondum,
d'après pytouchline d'abondoe, MIT), la bibliothèque de l'intégration Home
Assistant `touchline`. Voir `THIRD_PARTY_NOTICES.md`.
