<template>
  <main class="loginPage">
    <form class="loginForm" @submit.prevent="login">
      <h1>登录 Toonflow</h1>
      <p>使用管理员账号进入工作台</p>
      <label for="loginUsername">用户名</label>
      <input id="loginUsername" v-model="username" name="username" autocomplete="username" required maxlength="20" :disabled="pending" autofocus />
      <label for="loginPassword">密码</label>
      <input id="loginPassword" v-model="password" name="password" type="password" autocomplete="current-password" required maxlength="1024" :disabled="pending" />
      <p v-if="failure" class="loginError" role="alert">{{ failure }}</p>
      <button type="submit" :disabled="pending">{{ pending ? '登录中…' : '登录' }}</button>
    </form>
  </main>
</template>

<script setup lang="ts">
import { ref } from "vue";

const emit = defineEmits<{ authenticated: [] }>();
const username = ref("");
const password = ref("");
const pending = ref(false);
const failure = ref("");

async function login() {
  if (pending.value) return;
  pending.value = true;
  failure.value = "";
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.value, password: password.value }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || "登录失败，请重试");
    const session = await fetch("/api/auth/session", { cache: "no-store" });
    if (!session.ok) throw new Error("无法建立登录会话，请使用 HTTPS 并允许本站 Cookie");
    password.value = "";
    emit("authenticated");
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : "登录失败，请重试";
  } finally {
    pending.value = false;
  }
}
</script>

<style scoped lang="scss">
// ACT: 登录页在应用与 Element 深色变量加载前挂载，色值与 main.scss 的深色基调保持一致，不依赖主题切换。
.loginPage {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 24px;
  box-sizing: border-box;
  background: radial-gradient(ellipse at 50% 0%, color-mix(in srgb, #409eff 18%, transparent), transparent 60%), #0b0b0f;
  color: #e5e7eb;

  .loginForm {
    width: min(100%, 360px);
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 28px;
    border: 1px solid #2c2c36;
    border-radius: 16px;
    background: #18181f;

    h1 {
      font-size: 24px;
      margin: 0;
      background: linear-gradient(90deg, #409eff, color-mix(in srgb, #409eff 40%, #a855f7));
      background-clip: text;
      color: transparent;
    }
    p { margin: 0 0 12px; color: #a1a1aa; }
    label { font-size: 14px; }
    input, button { box-sizing: border-box; padding: 12px; border-radius: 8px; font: inherit; }
    input { min-width: 0; border: 1px solid #363641; background: #111116; color: #e5e7eb; }
    button { margin-top: 12px; border: 0; background: #409eff; color: white; cursor: pointer; }
    button:disabled { opacity: 0.6; cursor: wait; }
    input:focus-visible, button:focus-visible { outline: 3px solid #93c5fd; outline-offset: 2px; }
    .loginError { color: #f87171; overflow-wrap: anywhere; }
  }
}
</style>
