// class-data.js
// Minimal, PHB-style feature list for Barbarian 1–20 (no full rules text)

const CLASSES = {
  Barbarian: {
    hitDie: 12,
    primaryAbility: 'Strength',
    savingThrows: ['Strength', 'Constitution'],
    armorProficiencies: ['Light armor', 'Medium armor', 'Shields'],
    weaponProficiencies: ['Simple weapons', 'Martial weapons'],
    toolProficiencies: [],
    skillsChoose: 2,
    skillOptions: [
      'Animal Handling', 'Athletics', 'Intimidation',
      'Nature', 'Perception', 'Survival'
    ],
    // Table of key features by level
    levels: {
      1: {
        features: ['Rage', 'Unarmored Defense']
      },
      2: {
        features: ['Reckless Attack', 'Danger Sense']
      },
      3: {
        features: ['Primal Path']          // choose subclass here
      },
      4: {
        features: ['Ability Score Improvement']
      },
      5: {
        features: ['Extra Attack', 'Fast Movement']
      },
      6: {
        features: ['Path feature']         // subclass feature
      },
      7: {
        features: ['Feral Instinct']
      },
      8: {
        features: ['Ability Score Improvement']
      },
      9: {
        features: ['Brutal Critical (1 die)']
      },
      10: {
        features: ['Path feature']
      },
      11: {
        features: ['Relentless Rage']
      },
      12: {
        features: ['Ability Score Improvement']
      },
      13: {
        features: ['Brutal Critical (2 dice)']
      },
      14: {
        features: ['Path feature']
      },
      15: {
        features: ['Persistent Rage']
      },
      16: {
        features: ['Ability Score Improvement']
      },
      17: {
        features: ['Brutal Critical (3 dice)']
      },
      18: {
        features: ['Indomitable Might']
      },
      19: {
        features: ['Ability Score Improvement']
      },
      20: {
        features: ['Primal Champion']
      }
    },
    // Core feature descriptions, short (no copyrighted text)
    featureDetails: {
      'Rage':
        'Bonus action; gain damage resistance and bonus damage for a short time, limited uses per rest.',
      'Unarmored Defense':
        'When not wearing armor, AC = 10 + Dex mod + Con mod (you can still use a shield).',
      'Reckless Attack':
        'On your first attack each turn, you can get advantage on Strength melee attacks; attacks against you also get advantage until your next turn.',
      'Danger Sense':
        'Advantage on Dexterity saving throws against effects you can see, while not blinded, deafened, or incapacitated.',
      'Primal Path':
        'Choose a Barbarian subclass, which grants additional features at higher levels.',
      'Ability Score Improvement':
        'Increase one ability by 2, or two abilities by 1, or take an appropriate feat.',
      'Extra Attack':
        'When you take the Attack action, you can attack twice instead of once.',
      'Fast Movement':
        'While not wearing heavy armor, your speed increases by 10 feet.',
      'Feral Instinct':
        'Advantage on initiative rolls; acting normally while surprised if you rage immediately.',
      'Brutal Critical (1 die)':
        'Add one extra weapon damage die on critical hits with melee attacks.',
      'Brutal Critical (2 dice)':
        'Add two extra weapon damage dice on critical hits.',
      'Brutal Critical (3 dice)':
        'Add three extra weapon damage dice on critical hits.',
      'Relentless Rage':
        'While raging, dropping to 0 hit points lets you make a save to drop to 1 hp instead, once per long rest (more uses at higher levels).',
      'Persistent Rage':
        'Your rage only ends early if you fall unconscious or choose to end it.',
      'Indomitable Might':
        'If your Strength check total is less than your Strength score, you can use the score instead.',
      'Primal Champion':
        'Your Strength and Constitution scores each increase by 4; their maximum becomes 24 or higher depending on edition.'
    }
  }
};

if (typeof module !== 'undefined') {
  module.exports = { CLASSES };
}

if (typeof window !== 'undefined') {
  window.CLASSES = CLASSES;
}