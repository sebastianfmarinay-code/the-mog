'use strict';

/** The emoji and background colours people can pick for their avatar. */
const AVATAR_EMOJIS = [
  '🦊', '🐼', '🐸', '🐙', '🦄', '🐯', '🐨', '🐵',
  '🦉', '🐧', '🐳', '🦖', '👽', '🤖', '👾', '🎃',
  '🌵', '🍄', '🌈', '🔥', '⚡', '🍩', '🍕', '🎧',
];

const AVATAR_COLORS = [
  '#ff6b4a', '#ffb020', '#2ec27e', '#1fb6c9',
  '#3f7cff', '#8b5cf6', '#ec4899', '#64748b',
];

function isValidAvatar(avatar) {
  return Boolean(
    avatar &&
      typeof avatar === 'object' &&
      AVATAR_EMOJIS.includes(avatar.emoji) &&
      AVATAR_COLORS.includes(avatar.color),
  );
}

function randomAvatar() {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  return { emoji: pick(AVATAR_EMOJIS), color: pick(AVATAR_COLORS) };
}

module.exports = { AVATAR_EMOJIS, AVATAR_COLORS, isValidAvatar, randomAvatar };
