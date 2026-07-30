/**
 * THE NINTH VIGIL — objectives.
 *
 * A small quest chain, built from the encounter plan so it always describes work
 * that actually exists in the level: clear the hall, find the reliquary key, kill
 * the champion that holds the last junction, attune the shrine, reach the altar,
 * kill what is on it.
 *
 * Objectives are data. The Director publishes `snapshot()` on 'director:objectives'
 * and the HUD renders it; nothing here touches THREE or the DOM.
 *
 * Each objective is:
 *   { id, text, hint, kind, target, need, have, state, optional, order }
 * with `state` in 'locked' | 'active' | 'done' | 'failed'.
 *
 * Only one objective is `active` at a time in the main chain — that is what makes
 * a chain read as a chain — but optional side objectives (shrines, the reliquary)
 * are active as soon as they are unlocked so the HUD can show them alongside.
 */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class Objectives {
  /**
   * @param {import('../../core/Engine.js').Engine} engine
   * @param {import('./WorldState.js').WorldState} world
   */
  constructor(engine, world) {
    this.engine = engine;
    this.world = world;
    /** @type {Array<object>} */ this.list = [];
    this.title = 'The Descent';
    this.subtitle = '';
    this._revision = 0;
    this._activeEncounter = null;
  }

  get revision() { return this._revision; }
  touch() { this._revision++; return this; }

  reset() {
    this.list.length = 0;
    this._activeEncounter = null;
    return this.touch();
  }

  /* ================================================================ *
   * authoring
   * ================================================================ */

  build(name, cfg, plan, world) {
    this.list.length = 0;
    this.title = world.levelName;
    this.subtitle = `${world.tier.label} · monsters lv ${world.monsterLevel}`;

    const has = (kind) => plan.list.some((e) => e.kind === kind);
    const countOf = (kind) => plan.list.filter((e) => e.kind === kind).length;

    if (name === 'hub' || name === 'inventory' || name === 'closeup') {
      this.title = 'The Chapterhouse';
      this.subtitle = 'Rest, re-arm, and choose your descent';
      this._add({ id: 'hub.repair', kind: 'talk', text: 'Speak with the Armourer', hint: 'Repair and re-socket before you descend', need: 1 });
      this._add({ id: 'hub.stash', kind: 'talk', text: 'Empty your stash', hint: 'Nothing carried down is safe', need: 1, optional: true });
      this._add({ id: 'hub.descend', kind: 'reach', text: `Descend into ${world.levelName}`, hint: 'The waystone at the chapel steps', need: 1 });
      this._unlockNext();
      return this.touch();
    }

    if (name === 'combat') {
      this.title = world.levelName;
      this.subtitle = `${world.tier.label} · monsters lv ${world.monsterLevel}`;
      this._add({ id: 'combat.clear', kind: 'kill', text: 'Break the pack in the Great Hall', hint: 'They came out of the arcades', need: Math.max(1, plan.list.reduce((n, e) => n + (e.state === 'active' ? e.total : 0), 0) || 9) });
      this._add({ id: 'combat.champion', kind: 'kill', text: 'Slay the champion', hint: 'The big one holds them together', need: 1 });
      this._add({ id: 'combat.altar', kind: 'reach', text: 'Reach the altar stair', hint: 'North, past the collapse', need: 1 });
      this._unlockNext();
      return this.touch();
    }

    if (name === 'boss') {
      this.title = world.bossName;
      this.subtitle = `${world.tier.label} · boss lv ${world.levelFor('boss')}`;
      this._add({ id: 'boss.phase1', kind: 'boss', text: `Break ${world.bossName}'s guard`, hint: 'Phase I', need: 1, have: 1, state: 'done' });
      this._add({ id: 'boss.phase2', kind: 'boss', text: `Survive ${world.bossName}'s second phase`, hint: 'It calls the pack now', need: 1, state: 'active' });
      this._add({ id: 'boss.kill', kind: 'boss', text: `Kill ${world.bossName}`, hint: 'The third seal must not open', need: 1 });
      return this.touch();
    }

    /* --- the real chain, from the plan --- */
    const hall = plan.list.find((e) => e.kind === 'entrance');
    if (hall) {
      this._add({
        id: 'chain.explore', kind: 'explore',
        text: `Explore ${world.levelName}`,
        hint: 'Find the way down',
        need: Math.max(2, Math.ceil(plan.rooms.length * 0.6)),
      });
    }
    if (has('guard')) {
      this._add({
        id: 'chain.key', kind: 'collect',
        text: 'Find the Bonewright Key',
        hint: 'Sealed in a guarded reliquary',
        need: 1, optional: true,
      });
    }
    if (has('champion')) {
      this._add({
        id: 'chain.champion', kind: 'kill',
        text: 'Kill the champion that holds the junction',
        hint: 'It will not be alone',
        need: countOf('champion'),
      });
    }
    if (has('horde')) {
      this._add({
        id: 'chain.horde', kind: 'survive',
        text: 'Survive the tide',
        hint: 'Escalating waves — hold the room',
        need: 1, optional: true,
      });
    }
    if (has('shrine')) {
      this._add({
        id: 'chain.shrine', kind: 'shrine',
        text: 'Attune a shrine',
        hint: 'A blessing before the arena',
        need: 1, optional: true,
      });
    }
    this._add({
      id: 'chain.rooms', kind: 'clear',
      text: 'Clear the chambers',
      hint: 'Nothing follows you down',
      need: Math.max(1, plan.list.filter((e) => e.count > 0 && e.kind !== 'boss').length),
    });
    this._add({
      id: 'chain.altar', kind: 'reach',
      text: 'Reach the altar of the Third Seal',
      hint: 'The deepest chamber',
      need: 1,
    });
    this._add({
      id: 'chain.boss', kind: 'boss',
      text: `Destroy ${world.bossName}`,
      hint: 'It has been waiting',
      need: 1,
    });

    this._unlockNext();
    void cfg;
    return this.touch();
  }

  _add(o) {
    this.list.push({
      id: o.id, kind: o.kind ?? 'kill',
      text: o.text ?? o.id, hint: o.hint ?? '',
      need: Math.max(1, o.need ?? 1), have: o.have ?? 0,
      state: o.state ?? 'locked',
      optional: !!o.optional,
      order: this.list.length,
    });
  }

  /** Activate the first locked non-optional objective, plus every optional one. */
  _unlockNext() {
    let activatedMain = this.list.some((o) => o.state === 'active' && !o.optional);
    for (const o of this.list) {
      if (o.state !== 'locked') continue;
      if (o.optional) { o.state = 'active'; continue; }
      if (!activatedMain) { o.state = 'active'; activatedMain = true; }
    }
    return this.touch();
  }

  /* ================================================================ *
   * progress
   * ================================================================ */

  get(id) { return this.list.find((o) => o.id === id) ?? null; }

  /** @returns {boolean} true if this call completed the objective */
  progress(id, amount = 1) {
    const o = this.get(id);
    if (!o || o.state === 'done' || o.state === 'failed') return false;
    if (o.state === 'locked') o.state = 'active';
    o.have = Math.min(o.need, o.have + amount);
    this.touch();
    if (o.have >= o.need) { this.complete(id); return true; }
    this.engine.bus.emit('director:objective', this._snap(o));
    return false;
  }

  setProgress(id, have) {
    const o = this.get(id);
    if (!o || o.state === 'done') return false;
    const next = Math.min(o.need, Math.max(o.have, Math.round(have)));
    if (next === o.have) return false;
    o.have = next;
    this.touch();
    if (o.have >= o.need) { this.complete(id); return true; }
    this.engine.bus.emit('director:objective', this._snap(o));
    return false;
  }

  complete(id) {
    const o = this.get(id);
    if (!o || o.state === 'done') return false;
    o.state = 'done';
    o.have = o.need;
    this.engine.bus.emit('ui:toast', { text: `${o.text} — complete`, tier: 'good' });
    this.engine.bus.emit('director:objective', this._snap(o));
    this.engine.bus.emit('audio:sfx', { id: 'objective.complete', gain: 0.9 });
    this._unlockNext();
    return true;
  }

  /* -------------------------------------------------------- listeners */

  setActiveEncounter(enc) {
    this._activeEncounter = enc ?? null;
    if (!enc) return;
    if (enc.kind === 'guard') this.progress('chain.key', 0);
    this.touch();
  }

  noteEncounterCleared(enc, world) {
    if (!enc) return;
    if (enc.kind === 'champion') this.progress('chain.champion', 1);
    if (enc.kind === 'guard') this.complete('chain.key');
    if (enc.kind === 'horde') this.complete('chain.horde');
    if (enc.kind === 'boss') { this.complete('chain.boss'); this.complete('boss.kill'); }
    if (enc.count > 0 && enc.kind !== 'boss') {
      const done = world.cleared.size;
      this.setProgress('chain.rooms', done);
      this.setProgress('combat.clear', this.get('combat.clear')?.need ?? 1);
    }
    this.touch();
  }

  noteDiscovered(world) {
    this.setProgress('chain.explore', world.discovered.size);
  }

  noteShrine() {
    this.complete('chain.shrine');
  }

  noteReachedAltar() {
    this.complete('chain.altar');
    this.complete('combat.altar');
  }

  /* ================================================================ *
   * output
   * ================================================================ */

  _snap(o) {
    return {
      id: o.id, kind: o.kind, text: o.text, hint: o.hint,
      need: o.need, have: o.have, state: o.state, optional: o.optional,
      frac: clamp01(o.have / Math.max(1, o.need)), order: o.order,
    };
  }

  snapshot() {
    const list = this.list.map((o) => this._snap(o));
    const active = list.filter((o) => o.state === 'active');
    const done = list.filter((o) => o.state === 'done').length;
    return {
      title: this.title,
      subtitle: this.subtitle,
      list,
      active,
      primary: active.find((o) => !o.optional) ?? active[0] ?? null,
      completed: done,
      total: list.length,
      frac: list.length ? done / list.length : 0,
      revision: this._revision,
    };
  }
}

export default Objectives;
