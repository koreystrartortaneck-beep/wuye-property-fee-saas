<template>
  <div class="login-wrap">
    <el-card class="login-card">
      <h2 class="login-title">物业费管理后台</h2>
      <p class="login-sub">SaaS · 多小区收缴管理</p>
      <el-form @submit.prevent="submit">
        <el-form-item>
          <el-input v-model="username" placeholder="账号" size="large" autofocus />
        </el-form-item>
        <el-form-item>
          <el-input v-model="password" type="password" placeholder="密码" size="large" show-password @keyup.enter="submit" />
        </el-form-item>
        <el-button type="primary" size="large" class="login-btn" :loading="loading" @click="submit">登 录</el-button>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { store, type Profile } from '../store';

const username = ref('');
const password = ref('');
const loading = ref(false);
const router = useRouter();

async function submit() {
  if (!username.value || !password.value) return;
  loading.value = true;
  try {
    const data = await api<{ token: string; profile: Profile }>('/admin/auth/login', {
      method: 'POST',
      body: { username: username.value, password: password.value },
    });
    store.login(data.token, data.profile);
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
.login-btn {
  width: 100%;
}
</style>
