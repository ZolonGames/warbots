/**
 * Roll dice for combat
 * @param {string} diceString - e.g., "1d4", "2d6", "2d8"
 * @returns {number} Total roll result
 */
function rollDice(diceString) {
  const match = diceString.match(/(\d+)d(\d+)/);
  if (!match) return 0;

  const numDice = parseInt(match[1]);
  const dieSize = parseInt(match[2]);

  let total = 0;
  for (let i = 0; i < numDice; i++) {
    total += Math.floor(Math.random() * dieSize) + 1;
  }
  return total;
}

// Mech attack dice by type
const MECH_ATTACKS = {
  light: '1d4',
  medium: '1d6',
  heavy: '2d6',
  assault: '2d8'
};

// Fortification attack
const FORT_ATTACK = '2d6';
const FORT_HP = 10;

/**
 * Resolve combat at a single location
 * @param {Array} attackers - Array of mech objects (with id, type, hp, owner_id)
 * @param {Array} defenders - Array of mech objects
 * @param {Object|null} fortification - Fortification building or null
 * @returns {Object} Combat result { survivingAttackers, survivingDefenders, fortification, log }
 */
function resolveCombat(attackers, defenders, fortification) {
  const log = [];

  // Clone arrays to avoid modifying originals
  let activeAttackers = attackers.map(m => ({ ...m }));
  let activeDefenders = defenders.map(m => ({ ...m }));
  let activeFort = fortification ? { ...fortification } : null;

  // Combat continues until one side is eliminated
  let round = 0;
  const maxRounds = 10; // Safety limit

  while (activeAttackers.length > 0 && (activeDefenders.length > 0 || activeFort) && round < maxRounds) {
    round++;
    log.push(`--- Combat Round ${round} ---`);

    // Calculate attacker damage
    let attackerDamage = 0;
    for (const mech of activeAttackers) {
      const roll = rollDice(MECH_ATTACKS[mech.type]);
      attackerDamage += roll;
      log.push(`Attacker ${mech.type} rolls ${roll}`);
    }

    // Calculate defender damage (mechs + fortification)
    let defenderDamage = 0;
    for (const mech of activeDefenders) {
      const roll = rollDice(MECH_ATTACKS[mech.type]);
      defenderDamage += roll;
      log.push(`Defender ${mech.type} rolls ${roll}`);
    }

    if (activeFort) {
      const fortRoll = rollDice(FORT_ATTACK);
      defenderDamage += fortRoll;
      log.push(`Fortification rolls ${fortRoll}`);
    }

    // Apply attacker damage to defenders
    // Fortification absorbs damage first
    if (activeFort && attackerDamage > 0) {
      const fortDamage = Math.min(attackerDamage, activeFort.hp);
      activeFort.hp -= fortDamage;
      attackerDamage -= fortDamage;
      log.push(`Fortification takes ${fortDamage} damage (${activeFort.hp} HP remaining)`);

      if (activeFort.hp <= 0) {
        log.push('Fortification destroyed!');
        activeFort = null;
      }
    }

    // Remaining damage goes to mechs
    while (attackerDamage > 0 && activeDefenders.length > 0) {
      // Pick a random defender to take damage
      const targetIndex = Math.floor(Math.random() * activeDefenders.length);
      const target = activeDefenders[targetIndex];

      const damage = Math.min(attackerDamage, target.hp);
      target.hp -= damage;
      attackerDamage -= damage;
      log.push(`Defender ${target.type} takes ${damage} damage (${target.hp} HP remaining)`);

      if (target.hp <= 0) {
        log.push(`Defender ${target.type} destroyed!`);
        activeDefenders.splice(targetIndex, 1);
      }
    }

    // Apply defender damage to attackers
    while (defenderDamage > 0 && activeAttackers.length > 0) {
      const targetIndex = Math.floor(Math.random() * activeAttackers.length);
      const target = activeAttackers[targetIndex];

      const damage = Math.min(defenderDamage, target.hp);
      target.hp -= damage;
      defenderDamage -= damage;
      log.push(`Attacker ${target.type} takes ${damage} damage (${target.hp} HP remaining)`);

      if (target.hp <= 0) {
        log.push(`Attacker ${target.type} destroyed!`);
        activeAttackers.splice(targetIndex, 1);
      }
    }
  }

  // Determine winner
  let winner = null;
  if (activeAttackers.length > 0 && activeDefenders.length === 0 && !activeFort) {
    winner = 'attackers';
    log.push('Attackers win!');
  } else if (activeAttackers.length === 0) {
    winner = 'defenders';
    log.push('Defenders win!');
  } else {
    log.push('Combat continues (max rounds reached)');
  }

  return {
    survivingAttackers: activeAttackers,
    survivingDefenders: activeDefenders,
    fortification: activeFort,
    winner,
    log
  };
}

/**
 * Resolve multi-way combat at a single location
 * When multiple players' forces meet, resolve in random order
 * @param {Object} forcesByOwner - { playerId: { mechs: [], isDefender: boolean } }
 * @param {Object|null} fortification - Fortification (belongs to defender)
 * @param {number} defenderId - The defending player's ID (who owns the planet/position)
 * @returns {Object} Combat results
 */
function resolveMultiCombat(forcesByOwner, fortification, defenderId) {
  const log = [];
  const results = {};

  // Get list of all players involved
  const playerIds = Object.keys(forcesByOwner).map(Number);

  // Start with the defender's forces
  let currentDefender = defenderId;
  let currentDefenderMechs = forcesByOwner[defenderId]?.mechs || [];
  let currentFort = defenderId ? fortification : null;

  // Get attackers (everyone except defender)
  const attackerIds = playerIds.filter(id => id !== defenderId);

  // Randomize attacker order
  shuffleArray(attackerIds);

  for (const attackerId of attackerIds) {
    const attackerMechs = forcesByOwner[attackerId]?.mechs || [];

    if (attackerMechs.length === 0) continue;

    log.push(`\n=== Player ${attackerId} attacks Player ${currentDefender || 'neutral'} ===`);

    const result = resolveCombat(attackerMechs, currentDefenderMechs, currentFort);
    log.push(...result.log);

    if (result.winner === 'attackers') {
      // Attacker won - they become the new defender
      currentDefender = attackerId;
      currentDefenderMechs = result.survivingAttackers;
      currentFort = null; // Fort was destroyed or didn't exist
    } else {
      // Defender won - they keep defending
      currentDefenderMechs = result.survivingDefenders;
      currentFort = result.fortification;
    }

    // Store results for each player
    results[attackerId] = {
      survivingMechs: result.winner === 'attackers' ? result.survivingAttackers : [],
      won: result.winner === 'attackers'
    };
  }

  // Store final defender results
  if (currentDefender) {
    results[currentDefender] = {
      survivingMechs: currentDefenderMechs,
      won: true,
      isNewOwner: currentDefender !== defenderId
    };
  }

  return {
    finalOwner: currentDefenderMechs.length > 0 ? currentDefender : null,
    survivingMechs: currentDefenderMechs,
    fortification: currentFort,
    results,
    log
  };
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

module.exports = {
  rollDice,
  resolveCombat,
  resolveMultiCombat,
  MECH_ATTACKS
};
