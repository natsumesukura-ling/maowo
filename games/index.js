// Game registry. Adding a game means adding a module here; the platform does not change.
const modules = [require('./werewolf'), require('./gomoku')];
const byId = new Map(modules.map(m => [m.id, m]));

module.exports = {
  get: id => byId.get(id) || null,
  list: () => modules.map(m => ({ id: m.id, name: m.name, summary: m.summary })),
};
