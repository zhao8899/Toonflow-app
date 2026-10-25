<template>
  <template v-if="authRequired && userRole === 'admin'">
    <el-button text :disabled="pending" @click="accountsVisible = true">账号管理</el-button>
    <accountManagement v-model="accountsVisible" />
  </template>
  <el-button v-if="authRequired" text :disabled="pending" @click="passwordVisible = true">修改密码</el-button>
  <el-button v-if="authRequired" text :loading="pending" @click="logout">退出登录</el-button>
  <el-dialog v-model="passwordVisible" title="修改密码" width="min(440px, 92vw)" appendToBody :closeOnClickModal="!changingPassword" :closeOnPressEscape="!changingPassword" :showClose="!changingPassword" @closed="clearPasswords">
    <form class="passwordForm" @submit.prevent="changePassword">
      <p>修改成功后需要重新登录，其他设备的登录也会失效。请先保存当前工作。</p>
      <label :for="`${formId}Current`">当前密码</label>
      <el-input :id="`${formId}Current`" v-model="currentPassword" type="password" autocomplete="current-password" :maxlength="1024" :disabled="changingPassword" showPassword />
      <label :for="`${formId}New`">新密码（至少 12 个字符）</label>
      <el-input :id="`${formId}New`" v-model="newPassword" type="password" autocomplete="new-password" :maxlength="1024" :disabled="changingPassword" showPassword />
      <label :for="`${formId}Confirm`">确认新密码</label>
      <el-input :id="`${formId}Confirm`" v-model="confirmedPassword" type="password" autocomplete="new-password" :maxlength="1024" :disabled="changingPassword" showPassword />
      <p v-if="passwordError" class="passwordError" role="alert">{{ passwordError }}</p>
      <div class="passwordActions">
        <el-button :disabled="changingPassword" @click="passwordVisible = false">取消</el-button>
        <el-button type="primary" nativeType="submit" :loading="changingPassword">保存并重新登录</el-button>
      </div>
    </form>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, useId } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { authRequired, userRole } from "@/lib/auth";
import accountManagement from "@/components/accountManagement.vue";

const pending = ref(false);
const accountsVisible = ref(false);
const formId = useId();
const passwordVisible = ref(false);
const changingPassword = ref(false);
const currentPassword = ref("");
const newPassword = ref("");
const confirmedPassword = ref("");
const passwordError = ref("");

function clearPasswords() {
  currentPassword.value = "";
  newPassword.value = "";
  confirmedPassword.value = "";
  passwordError.value = "";
}

async function changePassword() {
  if (changingPassword.value) return;
  passwordError.value = "";
  if (!currentPassword.value || newPassword.value.length < 12) {
    passwordError.value = "请填写当前密码，并设置至少 12 个字符的新密码";
    return;
  }
  if (newPassword.value !== confirmedPassword.value) {
    passwordError.value = "两次输入的新密码不一致";
    return;
  }
  if (currentPassword.value === newPassword.value) {
    passwordError.value = "新密码不能与当前密码相同";
    return;
  }
  changingPassword.value = true;
  try {
    const response = await fetch("/api/auth/changePassword", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: currentPassword.value, newPassword: newPassword.value }),
    });
    if (response.status === 401) throw new Error("会话已失效，请刷新页面重新登录；若上次保存时断线，请尝试新密码");
    if (!response.ok) throw new Error((await response.json()).message || "修改失败，请重试");
    clearPasswords();
    window.location.reload();
  } catch (cause) {
    passwordError.value = cause instanceof Error ? cause.message : "未能确认修改结果，请重新登录确认，不要重复提交";
  } finally {
    changingPassword.value = false;
  }
}

async function logout() {
  if (pending.value) return;
  try {
    await ElMessageBox.confirm("退出将撤销本账号全部登录会话。请先保存当前工作，后台生成任务会继续运行。", "退出登录", {
      confirmButtonText: "退出登录", cancelButtonText: "取消", type: "warning",
    });
  } catch { return; }
  pending.value = true;
  try {
    const response = await fetch("/api/auth/revokeSessions", { method: "POST" });
    if (!response.ok && response.status !== 401) throw new Error((await response.json()).message || "退出失败，请重试");
    window.location.reload();
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : "退出失败，请重试");
    pending.value = false;
  }
}
</script>

<style scoped lang="scss">
.passwordForm {
  display: flex;
  flex-direction: column;
  gap: 12px;

  p { margin: 0; line-height: 1.6; }
  .passwordError { color: var(--el-color-danger); }
  .passwordActions { display: flex; justify-content: flex-end; margin-top: 12px; }
}
</style>
