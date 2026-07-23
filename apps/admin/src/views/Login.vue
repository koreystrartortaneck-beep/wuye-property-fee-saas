<template>
  <div class="login-wrap">
    <el-card class="login-card">
      <h2 class="login-title">物业费管理后台</h2>
      <p class="login-sub">收缴与财务管理</p>

      <!-- 登录 -->
      <el-form v-if="!mustChange" @submit.prevent="submit">
        <el-form-item>
          <el-input v-model="username" placeholder="账号" size="large" autofocus />
        </el-form-item>
        <el-form-item>
          <el-input v-model="password" type="password" placeholder="密码" size="large" show-password @keyup.enter="submit" />
        </el-form-item>
        <el-button type="primary" size="large" class="login-btn" :loading="loading" @click="submit">登 录</el-button>
      </el-form>

      <!-- 首次/强制改密 -->
      <el-form v-else @submit.prevent="doChange">
        <p class="login-tip">为保障账户安全，请先设置新密码（至少 12 位，含字母和数字）</p>
        <el-form-item>
          <el-input v-model="newPw" type="password" placeholder="新密码" size="large" show-password />
        </el-form-item>
        <el-form-item>
          <el-input v-model="newPw2" type="password" placeholder="确认新密码" size="large" show-password @keyup.enter="doChange" />
        </el-form-item>
        <el-button type="primary" size="large" class="login-btn" :loading="loading" @click="doChange">设置新密码并进入</el-button>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api } from '../api';
import { store, type Profile } from '../store';

const username = ref('');
const password = ref('');
const newPw = ref('');
const newPw2 = ref('');
const mustChange = ref(false);
const loading = ref(false);
const router = useRouter();

async function submit() {
  if (!username.value || !password.value) return;
  loading.value = true;
  try {
    const data = await api<{ token: string; profile: Profile; mustChangePassword?: boolean }>('/admin/auth/login', {
      method: 'POST',
      body: { username: username.value, password: password.value },
    });
    if (data.mustChangePassword) {
      // 受限会话：先存令牌用于改密调用，改完再正式进入
      store.login(data.token, data.profile);
      mustChange.value = true;
      return;
    }
    store.login(data.token, data.profile);
    router.push('/dashboard');
  } finally {
    loading.value = false;
  }
}

async function doChange() {
  if (newPw.value.length < 12) return ElMessage.warning('新密码至少 12 位');
  if (newPw.value !== newPw2.value) return ElMessage.warning('两次输入的新密码不一致');
  loading.value = true;
  try {
    const res = await api<{ token: string; profile: Profile }>('/admin/auth/change-password', {
      method: 'POST',
      body: { oldPassword: password.value, newPassword: newPw.value },
    });
    store.login(res.token, res.profile);
    ElMessage.success('密码已更新');
    router.push('/dashboard');
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(circle at 15% 10%, rgba(201, 166, 107, 0.25), transparent 30%),
    linear-gradient(180deg, #fbf6ee 0%, #efe3d0 100%);
}
.login-card {
  width: 380px;
  padding: 12px 8px;
  border-radius: 16px;
}
.login-title {
  margin: 0 0 4px;
  color: #102033;
}
.login-sub {
  margin: 0 0 24px;
  color: #8a7f73;
  font-size: 13px;
}
.login-tip {
  margin: 0 0 16px;
  color: #8a7f73;
  font-size: 13px;
  line-height: 1.6;
}
.login-btn {
  width: 100%;
}
</style>
