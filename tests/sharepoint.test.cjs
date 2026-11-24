const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, '../Daily_Task_form_Snabditeli.html'), 'utf8');
const script = new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
  filename: 'Daily_Task_form_Snabditeli.html',
});

const statusField = 'OData__x0421__x0442__x0430__x0442__x04';
const placeField = 'OData__x041c__x044f__x0441__x0442__x04';

function form() {
  const elements = new Map();
  const requests = [];
  const responses = [];
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        hidden: true,
        value: '',
        style: {},
        textContent: '',
        classList: new Set(),
      });
      elements.get(id).classList.remove = elements.get(id).classList.delete;
    }
    return elements.get(id);
  }
  const context = vm.createContext({
    document: {
      getElementById: id => id.startsWith('row-') ? elements.get(id) : element(id),
      addEventListener() {},
    },
    setTimeout() {},
    clearInterval() {},
    supabase: {
      createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: null } }),
          signOut: async () => {},
        },
      }),
    },
    fetch: async (url, options) => {
      requests.push(JSON.parse(options.body));
      assert(responses.length, 'An unexpected request was made');
      return responses.shift()(requests.at(-1));
    },
  });
  script.runInContext(context);
  context.currentRole = 'office';
  context.rebuildTable = () => {};
  context.updateStats = () => {};
  context.renderCards = () => {};
  element('lastSaved').textContent = 'Последно потвърдено обновяване';
  function addRow(fields = {}) {
    context.rowId++;
    const row = {
      id: context.rowId,
      spId: 31,
      savedToSP: true,
      status: 'За изпълнение',
      place: 'Стар адрес',
      ...fields,
    };
    context.rows.push(row);
    return row;
  }

  return {
    context,
    element,
    requests,
    addRow,
    reply: response => responses.push(typeof response === 'function' ? response : () => response),
    fail: () => responses.push(() => { throw new TypeError('Failed to fetch'); }),
  };
}

test('HTTP 500 preserves the saved address and keeps the correction open for retry', async () => {
  const { context, element, addRow, reply, requests } = form();
  const row = addRow();
  context.openEditModal(row.id);
  element('editPlaceInput').value = 'Нов адрес';
  reply(Response.json({ error: 'failed' }, { status: 500 }));
  await context.confirmEdit();

  assert.equal(row.place, 'Стар адрес');
  assert.equal(row.savedToSP, true);
  assert.equal(row.isSaving, false);
  assert.equal(context.pendingEditId, row.id);
  assert.match(element('toast').textContent, /HTTP 500/);
  assert.equal(element('lastSaved').textContent, 'Последно потвърдено обновяване');

  reply(new Response(null, { status: 204 }));
  await context.confirmEdit();
  assert.equal(requests[1].data.place, 'Нов адрес');
  assert.equal(row.place, 'Нов адрес');
  assert.equal(context.pendingEditId, null);
  assert.match(element('toast').textContent, /Адресът е коригиран/);
});

test('a JSON error in a 2xx update does not complete a delivery', async () => {
  const { context, element, addRow, reply } = form();
  const row = addRow({ status: 'В процес на изпълнение', supplier: 'Снабдител' });
  context.openDoneModal(row.id);
  element('deliveredOnInput').value = '2026-11-20';
  reply(Response.json({ error: 'upstream error' }));
  await context.confirmDone();

  assert.equal(context.rows[0], row);
  assert.equal(row.status, 'В процес на изпълнение');
  assert.equal(context.pendingDoneId, row.id);
  assert.match(element('toast').textContent, /не е потвърден/);

  reply(new Response(null, { status: 204 }));
  await context.confirmDone();
  assert.equal(context.rows.length, 0);
  assert.match(element('toast').textContent, /изпълнена и архивирана/);
});

for (const action of ['silentRefresh', 'loadFromSharePoint']) {
  test(action + ' preserves the last list on HTTP, network, and malformed response failures', async () => {
    const { context, element, addRow, reply, fail } = form();
    const row = addRow();
    const draft = addRow({ spId: null, savedToSP: false });
    const failures = [
      () => reply(Response.json({ error: 'unavailable' }, { status: 503 })),
      fail,
      () => reply(new Response('<html>error</html>')),
      () => reply(Response.json({})),
      () => reply(Response.json({ value: [{ ID: 99 }, {}] })),
    ];
    for (const failRefresh of failures) {
      failRefresh();
      assert.equal(await context[action](), false);
      assert.equal(context.rows.length, 2);
      assert.equal(context.rows[0], row);
      assert.equal(context.rows[1], draft);
      assert.equal(element('lastSaved').textContent, 'Последно потвърдено обновяване');
      assert.equal(element('refreshError').hidden, false);
      assert.equal(element('notif').innerHTML, undefined);
    }

    reply(Response.json({ value: [] }));
    assert.equal(await context[action](), true);
    assert.equal(context.rows.length, 1);
    assert.equal(context.rows[0], draft);
    assert.equal(element('refreshError').hidden, true);
    assert.equal(element('notif').innerHTML, undefined);
  });
}

test('refresh applies server changes and recognizes an explicitly completed task', async () => {
  const { context, element, addRow, reply } = form();
  const completed = addRow({ spId: 31 });
  const changed = addRow({ spId: '32' });
  const edited = addRow({ spId: 33, place: 'Чернова на адрес', savedToSP: false });
  reply(Response.json({ value: [
    { ID: 31, [statusField]: { Value: 'Изпълнена' } },
    { ID: 32, [placeField]: 'Обновен адрес' },
    { ID: 33, [placeField]: 'Адрес от сървъра' },
  ] }));
  assert.equal(await context.silentRefresh(), true);
  assert.equal(context.rows.includes(completed), false);
  assert.equal(context.rows.filter(row => Number(row.spId) === 32).length, 1);
  assert.equal(changed.place, 'Обновен адрес');
  assert.equal(edited.place, 'Чернова на адрес');
  assert.equal(edited.savedToSP, false);
  assert.match(element('notif').innerHTML, /Задача изпълнена/);
});

test('create requires an ID and retains the draft and current Office note for retry', async () => {
  const { context, element, addRow, reply, requests } = form();
  const draft = addRow({ spId: null, savedToSP: false, officeNote: 'Стара бележка' });
  element('row-' + draft.id).querySelectorAll = () => [];
  element('row-' + draft.id).querySelector = selector => {
    assert.equal(selector, 'textarea');
    return { value: 'Нова бележка' };
  };
  reply(Response.json({}));
  assert.equal(await context.saveRowToSharePoint(draft.id), false);
  assert.equal(draft.spId, null);
  assert.equal(draft.savedToSP, false);
  assert.equal(draft.isSaving, false);
  assert.equal(draft.officeNote, 'Нова бележка');
  assert.match(element('toast').textContent, /проверете преди повторен запис/);

  reply(Response.json({ ItemId: '75' }, { status: 201 }));
  assert.equal(await context.saveRowToSharePoint(draft.id), true);
  assert.equal(requests[1].data.officeNote, 'Нова бележка');
  assert.equal(draft.spId, '75');
  assert.equal(draft.savedToSP, true);
});

test('an in-flight save ignores duplicate submits and leaves newer edits unsaved', async () => {
  const { context, addRow, reply, requests } = form();
  const row = addRow({ savedToSP: false });
  let finish;
  reply(new Promise(resolve => { finish = resolve; }));
  const saving = context.saveRowToSharePoint(row.id);
  assert.equal(await context.saveRowToSharePoint(row.id), false);
  assert.equal(context.loadFromSharePoint(), undefined);
  context.updateField(row.id, 'place', 'По-нов адрес');
  finish(Response.json({ id: 31, detailsSaved: true }));

  assert.equal(await saving, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].data.details.place, 'Стар адрес');
  assert.equal(row.place, 'По-нов адрес');
  assert.equal(row.savedToSP, false);
  assert.equal(row.isSaving, false);
});

test('a refresh started before a write cannot overwrite the confirmed write', async () => {
  const { context, element, addRow, reply, requests } = form();
  const row = addRow();
  let finish;
  reply(new Promise(resolve => { finish = resolve; }));
  reply(new Response(null, { status: 204 }));

  const refresh = context.silentRefresh();
  assert.equal(context.loadFromSharePoint(), refresh);
  context.openEditModal(row.id);
  element('editPlaceInput').value = 'Нов адрес';
  await context.confirmEdit();
  finish(Response.json({ value: [{ ID: 31, [placeField]: 'Стар адрес' }] }));

  assert.equal(await refresh, false);
  assert.deepEqual(requests.map(request => request.action), ['get', 'update']);
  assert.equal(row.place, 'Нов адрес');
});

test('HTTP 401 preserves the list and shows the existing sign-in error', async () => {
  const { context, element, addRow, reply } = form();
  const row = addRow();
  reply(Response.json({ error: 'expired' }, { status: 401 }));
  assert.equal(await context.loadFromSharePoint(), false);
  assert.equal(context.rows[0], row);
  assert.equal(context.currentRole, null);
  assert.equal(element('loginScreen').style.display, 'flex');
  assert.match(element('officeError').textContent, /Сесията е изтекла/);
});

const { stripTypeScriptTypes } = require('node:module');

function fakeSharePoint() {
  const flow = JSON.parse(readFileSync(join(__dirname, '../power-automate/update-zadachi-details.json'), 'utf8'));
  const actions = flow.action.actions;
  const merge = actions.Merge_task_details.inputs.parameters;
  const expressions = [...merge['parameters/body'].matchAll(
    /contains\(triggerBody\(\)\?\['details'\], '([A-Za-z]+)'\), setProperty\(json\('\{\}'\), '([^']+)'/g
  )];
  const fields = Object.fromEntries(expressions.map(([, detail, field]) => [detail, field]));
  assert.deepEqual(Object.keys(fields).sort(), Object.keys(flow.triggerSchemaAdditions.details.properties).sort());
  assert.equal(merge['parameters/method'], 'POST');
  assert.equal(merge['parameters/headers']['X-HTTP-Method'], 'MERGE');
  assert.deepEqual(actions.Details_saved.runAfter, { Merge_task_details: ['Succeeded'] });
  assert.deepEqual(actions.Details_failed.runAfter, { Merge_task_details: ['Failed', 'TimedOut', 'Skipped'] });

  const saved = {
    ID: 31, [statusField]: 'В процес на изпълнение', [placeField]: 'Стар адрес',
    [fields.supplier]: 'Стар доставчик', [fields.specialist]: 'Стар специалист',
    [fields.direction]: 'Старо направление', [fields.deadline]: '2026-11-19T00:00:00Z',
  };
  const updates = [];
  const edgeSource = readFileSync(join(__dirname, '../supabase/functions/flow-proxy/index.ts'), 'utf8');
  const parsed = stripTypeScriptTypes(edgeSource.replace(/^import .*;\r?\n/, ''));
  const vars = {
    ALLOWED_ORIGINS: 'https://qa.example.invalid',
    SUPABASE_URL: 'https://qa-supabase.example.invalid',
    SUPABASE_ANON_KEY: 'test-publishable-key',
    DRIVER_TOKEN_SECRET: 'test-only-local-signing-secret',
    FLOW_DT_UPDATE: 'https://qa-flow.example.invalid/update',
    FLOW_DT_GET: 'https://qa-flow.example.invalid/get',
  };
  let handle;
  const edge = vm.createContext({
    Deno: { env: { get: key => vars[key] }, serve: callback => { handle = callback; } },
    TextEncoder, TextDecoder, crypto, atob, btoa, Response, console,
    createClient: () => ({
      auth: {
        getUser: async token => ({
          data: {
            user: { email: 'office@example.invalid', app_metadata: { providers: [token === 'office' ? 'azure' : 'email'] } },
          },
          error: null,
        }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({ eq: () => ({ limit: async () => ({ data: [{ id: 1 }] }) }) }),
        }),
      }),
    }),
    fetch: async (url, options) => {
      if (url === vars.FLOW_DT_GET) return Response.json({ value: [saved] });
      assert.equal(url, vars.FLOW_DT_UPDATE);
      const { id, details } = JSON.parse(options.body);
      updates.push({ id, details });
      if (!details) return new Response(null, { status: 204 });
      for (const [name, value] of Object.entries(details)) {
        assert(fields[name], 'The workflow must map ' + name);
        saved[fields[name]] = name === 'deadline' && value ? value + 'T00:00:00Z' : value;
      }
      return Response.json({ ...actions.Details_saved.inputs.body, id });
    },
  });
  vm.runInContext(parsed, edge);
  const request = (body, headers = { authorization: 'Bearer office' }) => handle(new Request('https://qa.example.invalid/', {
    method: 'POST',
    headers: { Origin: vars.ALLOWED_ORIGINS, ...headers },
    body: JSON.stringify(body),
  }));
  return { request, fields, saved, updates, driverToken: () => vm.runInContext('makeDriverToken("Test driver")', edge) };
}

test('editing four fields persists them and a fresh load reads the new values', async () => {
  const office = form();
  const backend = fakeSharePoint();
  office.reply(backend.request);
  assert.equal(await office.context.loadFromSharePoint(), true);
  const row = office.context.rows[0];
  const values = {
    firma: 'Нов доставчик',
    deadline: '2026-11-30',
    specialist: 'Нов специалист',
    direction: 'Ново направление',
  };
  for (const [field, value] of Object.entries(values)) office.context.updateField(row.id, field, value);
  office.reply(backend.request);
  await office.context.saveAllToSharePoint();
  assert.equal(row.savedToSP, true);
  assert.deepEqual(backend.updates, [{ id: 31, details: {
    supplier: values.firma, deadline: values.deadline, specialist: values.specialist, direction: values.direction,
  } }]);

  const reloaded = form();
  reloaded.reply(backend.request);
  await reloaded.context.loadFromSharePoint();
  const actual = reloaded.context.rows[0];
  for (const [field, value] of Object.entries(values)) assert.equal(actual[field], value);
  assert.equal(actual.place, 'Стар адрес');
  assert.equal(actual.status, 'В процес на изпълнение');
});

test('clearing the deadline updates only that field', async () => {
  const office = form();
  const backend = fakeSharePoint();
  office.reply(backend.request);
  assert.equal(await office.context.loadFromSharePoint(), true);
  const row = office.context.rows[0];
  office.context.updateField(row.id, 'deadline', '');
  office.reply(backend.request);
  assert.equal(await office.context.saveRowToSharePoint(row.id), true);
  assert.deepEqual(backend.updates, [{ id: 31, details: { deadline: null } }]);
  assert.equal(backend.saved[backend.fields.deadline], null);
  assert.equal(backend.saved[backend.fields.supplier], 'Стар доставчик');
});

test('an update without explicit acknowledgement leaves the edited row pending', async () => {
  const { context, addRow, element, reply, requests } = form();
  const row = addRow({ spId: '31', firma: 'Стар доставчик' });
  context.updateField(row.id, 'firma', 'Нов доставчик');
  reply(Response.json({ id: 31 }));
  assert.equal(await context.saveRowToSharePoint(row.id), false);
  assert.equal(row.savedToSP, false);
  assert.match(element('toast').textContent, /не е потвърден/);
  reply(Response.json({ id: 31, detailsSaved: true }));
  assert.equal(await context.saveRowToSharePoint(row.id), true);
  assert.equal(row.savedToSP, true);
  assert.deepEqual(requests[0], requests[1]);
});

test('the proxy rejects driver detail edits, invalid dates, unknown fields and legacy detail payloads', async () => {
  const backend = fakeSharePoint();
  const payload = { id: 31, details: { deadline: null } };
  const action = (name, data) => ({ app: 'daily-tasks', action: name, data });
  const driver = { 'x-driver-token': await backend.driverToken() };
  assert.equal((await backend.request(action('edit-details', payload), driver)).status, 403);
  assert.equal((await backend.request(action('edit-details', payload), { authorization: 'Bearer other' })).status, 403);
  assert.equal((await backend.request(action(['edit-details'], payload), driver)).status, 400);
  assert.equal((await backend.request({ app: ['daily-tasks'], action: 'edit-details', data: payload }, driver)).status, 400);
  assert.equal((await backend.request(action('update', payload), driver)).status, 400);
  assert.equal((await backend.request(action('edit-details', { ...payload, details: { deadline: '2026-02-30' } }))).status, 400);
  assert.equal((await backend.request(action('edit-details', { ...payload, details: { status: 'Изпълнена' } }))).status, 400);
  assert.equal(backend.updates.length, 0);
  assert.equal((await backend.request(action('update', { id: 31, status: 'Изпълнена' }), driver)).status, 204);
  assert.deepEqual(backend.updates, [{ id: 31, details: undefined }]);
});
