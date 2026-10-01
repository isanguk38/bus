import { ApiError } from './http.js';

const kstDate = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

// 공공데이터포털 개발계정은 API마다 하루 호출 한도가 있다.
// 한도를 넘기면 그날은 키 자체가 막히므로 서버에서 미리 세고 멈춘다.
// (메모리 카운터라 서버가 재시작되면 0부터 다시 센다.)
export class Quota {
  constructor(name, limit) {
    this.name = name;
    this.limit = limit;
    this.day = kstDate();
    this.used = 0;
  }

  #roll() {
    const today = kstDate();
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
  }

  take() {
    this.#roll();
    if (this.used >= this.limit) {
      throw new ApiError(`${this.name} API의 오늘 호출 한도(${this.limit}회)를 모두 사용했습니다.`, {
        status: 429,
        code: 'QUOTA_EXCEEDED',
      });
    }
    this.used += 1;
  }

  snapshot() {
    this.#roll();
    return { name: this.name, day: this.day, used: this.used, limit: this.limit };
  }
}
