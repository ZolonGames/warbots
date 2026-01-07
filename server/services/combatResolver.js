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
 * Combat is sequential: each round, all units are shuffled and attack one at a time.
 * Each unit picks a target, rolls damage, and applies it immediately.
 * Destroyed units cannot attack.
 *
 * @param {Array} attackers - Array of mech objects (with id, type, hp, owner_id)
 * @param {Array} defenders - Array of mech objects
 * @param {Object|null} fortification - Fortification building or null
 * @param {number} attackerId - Attacker player ID
 * @param {number} defenderId - Defender player ID
 * @returns {Object} Combat result with detailed log
 */
function resolveCombat(attackers, defenders, fortification, attackerId, defenderId) {
  const detailedLog = []; // Detailed roll-by-roll for participants

  // Clone arrays to avoid modifying originals, tagging each with their side
  let activeAttackers = attackers.map(m => ({ ...m, side: 'attacker', playerId: attackerId }));
  let activeDefenders = defenders.map(m => ({ ...m, side: 'defender', playerId: defenderId }));
  let activeFort = fortification ? { ...fortification, side: 'defender', playerId: defenderId } : null;

  const initialAttackerCount = activeAttackers.length;
  const initialDefenderCount = activeDefenders.length;

  // Combat continues until one side is eliminated
  let round = 0;
  const maxRounds = 20; // Safety limit

  while (activeAttackers.length > 0 && (activeDefenders.length > 0 || activeFort) && round < maxRounds) {
    round++;
    detailedLog.push({ type: 'round', round });

    // Helper function to process a single attack
    function processAttack(unit, unitType) {
      // Determine valid targets (opposing side)
      let targets = [];
      if (unit.side === 'attacker') {
        // Attackers MUST target fortification first if it exists
        if (activeFort && activeFort.hp > 0) {
          targets = [{ unit: activeFort, type: 'fortification' }];
        } else {
          targets = activeDefenders.filter(m => m.hp > 0).map(m => ({ unit: m, type: 'mech' }));
        }
      } else {
        // Defenders (including fort) target attackers
        targets = activeAttackers.filter(m => m.hp > 0).map(m => ({ unit: m, type: 'mech' }));
      }

      if (targets.length === 0) return; // No valid targets

      // Pick a random target
      const targetIndex = Math.floor(Math.random() * targets.length);
      const target = targets[targetIndex];

      // Roll damage
      const diceString = unitType === 'fortification' ? FORT_ATTACK : MECH_ATTACKS[unit.type];
      const roll = rollDice(diceString);

      // Log the attack
      detailedLog.push({
        type: 'attack',
        attackerSide: unit.side,
        attackerType: unitType === 'fortification' ? 'fortification' : unit.type,
        attackerPlayerId: unit.playerId,
        targetSide: target.unit.side,
        targetType: target.type === 'fortification' ? 'fortification' : target.unit.type,
        targetPlayerId: target.unit.playerId,
        roll
      });

      // Apply damage
      target.unit.hp -= roll;

      detailedLog.push({
        type: 'damage',
        side: target.unit.side,
        mechType: target.type === 'fortification' ? 'fortification' : target.unit.type,
        damage: roll,
        hpRemaining: Math.max(0, target.unit.hp),
        playerId: target.unit.playerId
      });

      // Check if target is destroyed
      if (target.unit.hp <= 0) {
        detailedLog.push({
          type: 'destroyed',
          side: target.unit.side,
          mechType: target.type === 'fortification' ? 'fortification' : target.unit.type,
          playerId: target.unit.playerId
        });

        if (target.type === 'fortification') {
          activeFort = null;
        } else {
          // Remove from active list
          if (target.unit.side === 'attacker') {
            activeAttackers = activeAttackers.filter(m => m.id !== target.unit.id);
          } else {
            activeDefenders = activeDefenders.filter(m => m.id !== target.unit.id);
          }
        }
      }
    }

    // PHASE 1: Fortification attacks first (if exists)
    if (activeFort && activeFort.hp > 0 && activeAttackers.length > 0) {
      processAttack(activeFort, 'fortification');
    }

    // PHASE 2: All mechs attack in randomized order
    // Build list of all mechs for this round
    const combatants = [];
    for (const mech of activeAttackers) {
      combatants.push({ unit: mech, type: 'mech' });
    }
    for (const mech of activeDefenders) {
      combatants.push({ unit: mech, type: 'mech' });
    }

    // Randomize attack order for this round
    shuffleArray(combatants);

    // Each mech attacks in order
    for (const combatant of combatants) {
      const { unit, type } = combatant;

      // Check if this unit is still alive (might have been destroyed earlier this round)
      const isAttacker = unit.side === 'attacker';
      const stillAlive = isAttacker
        ? activeAttackers.some(m => m.id === unit.id && m.hp > 0)
        : activeDefenders.some(m => m.id === unit.id && m.hp > 0);

      if (!stillAlive) continue; // Skip destroyed mechs

      // Check if there are valid targets
      if (isAttacker && activeDefenders.length === 0 && (!activeFort || activeFort.hp <= 0)) continue;
      if (!isAttacker && activeAttackers.length === 0) continue;

      processAttack(unit, type);
    }

    // Clean up any mechs that might have 0 or less HP
    activeAttackers = activeAttackers.filter(m => m.hp > 0);
    activeDefenders = activeDefenders.filter(m => m.hp > 0);
    if (activeFort && activeFort.hp <= 0) activeFort = null;
  }

  // Determine winner
  let winner = null;
  let winnerId = null;
  if (activeAttackers.length > 0 && activeDefenders.length === 0 && !activeFort) {
    winner = 'attackers';
    winnerId = attackerId;
  } else if (activeAttackers.length === 0) {
    winner = 'defenders';
    winnerId = defenderId;
  }

  const attackerCasualties = initialAttackerCount - activeAttackers.length;
  const defenderCasualties = initialDefenderCount - activeDefenders.length;

  // Remove the side/playerId tags we added before returning
  const cleanMech = m => ({ id: m.id, type: m.type, hp: m.hp, max_hp: m.max_hp, owner_id: m.owner_id, designation: m.designation });

  return {
    survivingAttackers: activeAttackers.map(cleanMech),
    survivingDefenders: activeDefenders.map(cleanMech),
    fortification: activeFort ? { id: activeFort.id, hp: activeFort.hp, type: activeFort.type } : null,
    winner,
    winnerId,
    attackerId,
    defenderId,
    attackerCasualties,
    defenderCasualties,
    detailedLog
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
  const results = {};
  const battles = []; // Store each battle's detailed info

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

  // Track total casualties
  let totalAttackerCasualties = 0;
  let totalDefenderCasualties = 0;
  const initialDefenderCount = currentDefenderMechs.length;

  for (const attackerId of attackerIds) {
    const attackerMechs = forcesByOwner[attackerId]?.mechs || [];

    if (attackerMechs.length === 0) continue;

    const result = resolveCombat(attackerMechs, currentDefenderMechs, currentFort, attackerId, currentDefender);

    battles.push({
      attackerId,
      defenderId: currentDefender,
      detailedLog: result.detailedLog,
      winner: result.winner,
      winnerId: result.winnerId,
      attackerCasualties: result.attackerCasualties,
      defenderCasualties: result.defenderCasualties
    });

    totalAttackerCasualties += result.attackerCasualties;
    totalDefenderCasualties += result.defenderCasualties;

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
    battles,
    participants: playerIds,
    winnerId: currentDefenderMechs.length > 0 ? currentDefender : null,
    originalDefenderId: defenderId,
    totalAttackerCasualties,
    totalDefenderCasualties: initialDefenderCount - currentDefenderMechs.length
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
