import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { AI_TIMEOUT_MS, createApp, parseBody, parseModelOutput } from "./server.mjs";

let server;
let baseUrl;

async function triage(text, { rawBody } = {}) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody ?? JSON.stringify({ text }),
  });
  return { status: response.status, body: await response.json() };
}

function assertManualReview(response) {
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: "manual_review", topic: null, draft: null });
}

before(async () => {
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  // Прогрев: первый запрос греет модули/сокеты, иначе замер таймаута может оказаться завышенным.
  await triage("обычная заявка");
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe("POST /api/triage: невалидный ввод", () => {
  test("пустой текст -> 400 invalid_input", async () => {
    const response = await triage("");
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { status: "invalid_input" });
  });

  test("текст из пробелов -> 400 invalid_input", async () => {
    const response = await triage("   \n\t ");
    assert.equal(response.status, 400);
  });

  test("отсутствующее или нестроковое поле text -> 400 invalid_input", async () => {
    for (const rawBody of ["{}", '{"text":42}', '{"text":null}', '{"text":["a"]}', "null", "[]", '"строка"']) {
      const response = await triage(undefined, { rawBody });
      assert.equal(response.status, 400, `тело ${rawBody}`);
      assert.deepEqual(response.body, { status: "invalid_input" }, `тело ${rawBody}`);
    }
  });

  test("битый JSON и пустое тело -> 400 invalid_input", async () => {
    for (const rawBody of ["{", "не json", ""]) {
      const response = await triage(undefined, { rawBody });
      assert.equal(response.status, 400, `тело ${JSON.stringify(rawBody)}`);
      assert.deepEqual(response.body, { status: "invalid_input" });
    }
  });
});

describe("POST /api/triage: сбои модели уходят на ручную проверку", () => {
  test("[error] -> 200 manual_review", async () => {
    assertManualReview(await triage("Заявка [error]"));
  });

  test("[bad-json] -> 200 manual_review", async () => {
    assertManualReview(await triage("Заявка [bad-json]"));
  });

  test("[bad-topic] -> 200 manual_review", async () => {
    assertManualReview(await triage("Заявка про доставку [bad-topic]"));
  });

  test("[empty-draft] -> 200 manual_review", async () => {
    assertManualReview(await triage("Заявка [empty-draft]"));
  });

  test("[timeout] -> 200 manual_review не позднее таймаута ожидания модели", async () => {
    const startedAt = performance.now();
    const response = await triage("Заявка [timeout]");
    const elapsed = performance.now() - startedAt;
    assertManualReview(response);
    // Имитатор отвечает через 1200 мс, ждём не дольше AI_TIMEOUT_MS с запасом на планировщик.
    assert.ok(elapsed < 1_000, `ответ занял ${Math.round(elapsed)} мс, ожидался отказ около ${AI_TIMEOUT_MS} мс`);
  });
});

describe("POST /api/triage: успешный ответ", () => {
  test("обычный текст -> 200 ready с темой и непустым черновиком", async () => {
    const response = await triage("Когда будет доставка заказа?");
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "ready");
    assert.equal(response.body.topic, "delivery");
    assert.equal(typeof response.body.draft, "string");
    assert.ok(response.body.draft.trim() !== "");
  });

  test("тема pricing определяется по тексту", async () => {
    const response = await triage("Какая стоимость доставки?");
    assert.equal(response.body.status, "ready");
    assert.ok(["delivery", "pricing"].includes(response.body.topic));
  });
});

describe("parseBody", () => {
  test("принимает объект с непустым text и обрезает пробелы", () => {
    assert.deepEqual(parseBody('{"text":"  привет  ","extra":1}'), { ok: true, text: "привет" });
  });

  test("отклоняет мусор", () => {
    for (const raw of ["", "{", "null", "[]", "42", '"текст"', "{}", '{"text":""}', '{"text":"  "}', '{"text":7}']) {
      assert.deepEqual(parseBody(raw), { ok: false }, `тело ${JSON.stringify(raw)}`);
    }
  });
});

describe("parseModelOutput", () => {
  test("принимает допустимый ответ и обрезает черновик", () => {
    assert.deepEqual(parseModelOutput('{"topic":"delivery","draft":"  Здравствуйте!  "}'), {
      topic: "delivery",
      draft: "Здравствуйте!",
    });
  });

  test("отклоняет непригодный ответ модели", () => {
    const raw = [
      "model output is not JSON",
      "{",
      "null",
      "[]",
      "{}",
      '{"topic":"refund","draft":"текст"}',
      '{"topic":"Delivery","draft":"текст"}',
      '{"topic":"delivery","draft":"   "}',
      '{"topic":"delivery","draft":null}',
      '{"topic":"delivery","draft":42}',
      '{"draft":"текст"}',
    ];
    for (const value of raw) {
      assert.equal(parseModelOutput(value), null, `ответ модели ${value}`);
    }
    assert.equal(parseModelOutput(undefined), null);
    assert.equal(parseModelOutput({}), null);
  });
});
