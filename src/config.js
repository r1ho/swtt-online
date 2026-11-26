'use strict';

const CHARACTERS = [
  {
    key: 'yunshuimu',
    name: '云水母',
    avatar: '/assets/avatars/yunshuimu.webp?v=beige2',
    cardImage: '/assets/characters/yunshuimu.jpg',
    gender: 'male',
    country: '中国台北',
    language: '中文',
    color: '#86e3f2',
    homeTile: null,
    ability: [
      '丑发型：到达【理发店】可免受暂停惩罚',
      '蛰伏：积分≤2500时，每次掷骰子获得点数×10积分',
      '羁绊：与张本智鳐同格双方+200；与张本美鳐同格，需支付她200；与豚鲁斯同格，可选择让豚鲁斯移动到张本智鳐所在位置',
    ],
  },
  {
    key: 'bulugui',
    name: '布鲁龟',
    avatar: '/assets/avatars/bulugui.webp?v=beige2',
    cardImage: '/assets/characters/bulugui.jpg',
    gender: 'female',
    country: '巴西',
    language: '葡萄牙语',
    color: '#8ee0a8',
    homeTile: 20,
    ability: [
      '主场优势：到达【伊瓜苏】+250积分',
      '羁绊：和雨果龟同格双方+200',
      '支付其他玩家积分时，除最高位外由雨果龟支付',
    ],
  },
  {
    key: 'zhangbenzhiyao',
    name: '张本智鳐',
    avatar: '/assets/avatars/zhangbenzhiyao.webp?v=beige2',
    cardImage: '/assets/characters/zhangbenzhiyao.jpg',
    gender: 'male',
    country: '日本',
    language: '日语',
    color: '#f4ac66',
    homeTile: 21,
    ability: [
      '主场优势：到达【横滨】+250积分',
      '羁绊：到达张本美鳐的地产时只支付一半费用',
      '和云水母处于同一格时，双方积分+200',
    ],
  },
  {
    key: 'zhangbenmeiyao',
    name: '张本美鳐',
    avatar: '/assets/avatars/zhangbenmeiyao.webp?v=beige2',
    cardImage: '/assets/characters/zhangbenmeiyao.jpg',
    gender: 'female',
    country: '日本',
    language: '日语',
    color: '#f8b9cc',
    homeTile: 21,
    ability: [
      '主场优势：到达【横滨】+250积分',
      '羁绊：到达张本智鳐的地产时只支付一半费用',
      '和云水母处于同一格时，云水母需支付你200积分',
    ],
  },
  {
    key: 'aolikeyou',
    name: '艾利克鱿',
    avatar: '/assets/avatars/aolikeyou.webp?v=beige2',
    cardImage: '/assets/characters/aolikeyou.jpg',
    gender: 'male',
    country: '法国',
    language: '法语',
    color: '#a99bf5',
    homeTile: 30,
    ability: [
      '主场优势：到达【蒙彼利埃】+250积分',
      '急脾气：前进时掷出1需重新投掷',
      '羁绊：和菲利克鱿同格双方+200',
    ],
  },
  {
    key: 'feilikeyou',
    name: '菲利克鱿',
    avatar: '/assets/avatars/feilikeyou.webp?v=beige2',
    cardImage: '/assets/characters/feilikeyou.jpg',
    gender: 'male',
    country: '法国',
    language: '法语',
    color: '#f3ce67',
    homeTile: 30,
    ability: [
      '主场优势：到达【蒙彼利埃】+250积分',
      '急脾气：前进时掷出1需重新投掷',
      '羁绊：和艾利克鱿同格双方+200',
    ],
  },
  {
    key: 'tunlusi',
    name: '豚鲁斯',
    avatar: '/assets/avatars/tunlusi.webp?v=beige2',
    cardImage: '/assets/characters/tunlusi.jpg',
    gender: 'male',
    country: '瑞典',
    language: '瑞典语',
    color: '#f09a7e',
    homeTile: 23,
    ability: [
      '主场优势：到达【马尔默】（瑞典大满贯）+250积分',
      '神的旨意：整局一次指定本人下一次骰子点数',
    ],
  },
  {
    key: 'yuguogui',
    name: '雨果龟',
    avatar: '/assets/avatars/yuguogui.webp?v=beige2',
    cardImage: '/assets/characters/yuguogui.jpg',
    gender: 'male',
    country: '巴西',
    language: '葡萄牙语',
    color: '#7bb8ef',
    homeTile: 20,
    ability: [
      '主场优势：到达【伊瓜苏】+250积分',
      '人物羁绊：和【布鲁龟】处于同一格，双方积分+200',
      '强健体魄：到达【健身房】时可获得双倍积分',
      '【布鲁龟】支付其他人积分时，除最高位外由该玩家支付',
    ],
  },
];

// 棋盘为 36 格，0 号格为左上角训练场，顺时针前进。
const TILES = [
  {
    id: 0, kind: 'training', name: '训练场', short: '训练场', corner: true,
    x: 7.26, y: 11.01,
  },
  {
    id: 1, kind: 'tournament', name: '多哈冠军赛', short: '多哈冠军赛', points: 1000,
    region: '卡塔尔', languages: ['阿拉伯语'], x: 18.56, y: 16.65,
  },
  {
    id: 2, kind: 'tournament', name: '多哈球星挑战赛', short: '多哈球星挑战赛', points: 600,
    region: '卡塔尔', languages: ['阿拉伯语'], x: 25.52, y: 16.65,
  },
  {
    id: 3, kind: 'tournament', name: '旧金山美洲杯', short: '旧金山美洲杯', points: 500,
    region: '美国', languages: ['英语'], x: 32.49, y: 16.65,
  },
  {
    id: 4, kind: 'chance', name: '机会', short: '机会', x: 39.49, y: 16.65,
  },
  {
    id: 5, kind: 'tournament', name: '基督城大洋洲杯', short: '基督城大洋洲杯', points: 500,
    region: '新西兰', languages: ['英语'], x: 46.46, y: 16.65,
  },
  {
    id: 6, kind: 'tournament', name: '蒙特利尔欧洲杯', short: '蒙特利尔欧洲杯', points: 500,
    region: '加拿大', languages: ['英语', '法语'], x: 53.42, y: 16.65,
  },
  {
    id: 7, kind: 'fate', name: '命运', short: '命运', x: 60.38, y: 16.65,
  },
  {
    id: 8, kind: 'tournament', name: '班加西非洲杯', short: '班加西非洲杯', points: 500,
    region: '利比亚', languages: ['阿拉伯语'], x: 67.36, y: 16.65,
  },
  {
    id: 9, kind: 'tournament', name: '金奈球星挑战赛', short: '金奈', points: 600,
    region: '印度', languages: ['英语', '印地语'], special: 'jinNai', x: 74.34, y: 16.65,
  },
  {
    id: 10, kind: 'tournament', name: '海口亚洲杯', short: '海口亚洲杯', points: 500,
    region: '中国', languages: ['中文'], x: 81.25, y: 16.65,
  },
  {
    id: 11, kind: 'barber', name: '理发店', short: '理发店', corner: true, x: 92.52, y: 11.01,
  },
  {
    id: 12, kind: 'tournament', name: '新加坡大满贯', short: '新加坡大满贯', points: 2000,
    region: '新加坡', languages: ['英语'], x: 87.68, y: 25.49,
  },
  {
    id: 13, kind: 'tournament', name: '重庆冠军赛', short: '重庆冠军赛', points: 1000,
    region: '中国大陆', languages: ['中文'], x: 87.68, y: 35.20,
  },
  {
    id: 14, kind: 'tournament', name: '澳门单打世界杯', short: '澳门单打世界杯', points: 1500,
    region: '中国澳门', languages: ['中文', '葡萄牙语'], x: 87.68, y: 45.02,
  },
  {
    id: 15, kind: 'fate', name: '命运', short: '命运', x: 87.68, y: 54.81,
  },
  {
    id: 16, kind: 'tournament', name: '伦敦世乒赛团体', short: '伦敦世乒赛团体', points: 300,
    region: '英国', languages: ['英语'], special: 'diceBonus', noPurchase: true, x: 87.68, y: 64.64,
  },
  {
    id: 17, kind: 'tournament', name: '卢布尔雅那球星挑战赛', short: '卢布尔雅那球星挑战赛', points: 600,
    region: '斯洛文尼亚', languages: ['斯洛文尼亚语'], x: 87.68, y: 74.43,
  },
  {
    id: 18, kind: 'gym', name: '健身房', short: '健身房', corner: true, x: 92.52, y: 89.19,
  },
  {
    id: 19, kind: 'tournament', name: '美国大满贯', short: '美国大满贯', points: 2000,
    region: '美国', languages: ['英语'], x: 81.25, y: 83.55,
  },
  {
    id: 20, kind: 'tournament', name: '伊瓜苏球星挑战赛', short: '伊瓜苏球星挑战赛', points: 600,
    region: '巴西', languages: ['葡萄牙语'], x: 74.34, y: 83.55,
  },
  {
    id: 21, kind: 'tournament', name: '横滨冠军赛', short: '横滨冠军赛', points: 1000,
    region: '日本', languages: ['日语'], x: 67.36, y: 83.55,
  },
  {
    id: 22, kind: 'chance', name: '机会', short: '机会', x: 60.38, y: 83.55,
  },
  {
    id: 23, kind: 'tournament', name: '瑞典大满贯', short: '瑞典大满贯', points: 2000,
    region: '瑞典', languages: ['瑞典语'], x: 53.42, y: 83.55,
  },
  {
    id: 24, kind: 'tournament', name: '澳门冠军赛', short: '澳门冠军赛', points: 1000,
    region: '中国澳门', languages: ['中文', '葡萄牙语'], x: 46.46, y: 83.55,
  },
  {
    id: 25, kind: 'fate', name: '命运', short: '命运', x: 39.49, y: 83.55,
  },
  {
    id: 26, kind: 'tournament', name: '伦敦球星挑战赛', short: '伦敦球星挑战赛', points: 600,
    region: '英国', languages: ['英语'], x: 32.49, y: 83.55,
  },
  {
    id: 27, kind: 'tournament', name: '中国大满贯', short: '中国大满贯', points: 2000,
    region: '中国大陆', languages: ['中文'], x: 25.52, y: 83.55,
  },
  {
    id: 28, kind: 'tournament', name: '塔什干亚锦赛', short: '塔什干亚锦赛', points: 500,
    region: '乌兹别克斯坦', languages: ['乌兹别克语'], x: 18.56, y: 83.55,
  },
  {
    id: 29, kind: 'sponsor', name: '获得赞助', short: '获得赞助', corner: true, x: 7.26, y: 89.19,
  },
  {
    id: 30, kind: 'tournament', name: '蒙彼利埃冠军赛', short: '蒙彼利埃冠军赛', points: 1000,
    region: '法国', languages: ['法语'], x: 12.09, y: 74.51,
  },
  {
    id: 31, kind: 'tournament', name: '法兰克福冠军赛', short: '法兰克福冠军赛', points: 1000,
    region: '德国', languages: ['德语'], x: 12.09, y: 64.83,
  },
  {
    id: 32, kind: 'tournament', name: '马斯喀特球星挑战赛', short: '马斯喀特球星挑战赛', points: 600,
    region: '阿曼', languages: ['阿拉伯语'], x: 12.09, y: 55.04,
  },
  {
    id: 33, kind: 'chance', name: '机会', short: '机会', x: 12.09, y: 45.22,
  },
  {
    id: 34, kind: 'tournament', name: '成都混团世界杯', short: '成都混团世界杯', points: 300,
    region: '中国大陆', languages: ['中文'], special: 'diceBonus', noPurchase: true, x: 12.09, y: 35.45,
  },
  {
    id: 35, kind: 'tournament', name: '香港总决赛', short: '香港总决赛', points: 1500,
    region: '中国香港', languages: ['中文', '英语'], x: 12.09, y: 25.66,
  },
];

const CARDS = {
  chance: [
    {
      key: 'ttr', name: 'TTR', deck: 'chance', image: '/assets/cards/jihui/ttr.jpg',
      desc: '掷骰子，点数≤3积分+200，否则积分-200。',
    },
    {
      key: 'pingshu', name: '乒超', deck: 'chance', image: '/assets/cards/jihui/pingshu.jpg', persistent: true,
      desc: '之后每次到达中国大陆，掷骰子积分+点数×10；掷到6时此卡不再生效。',
    },
    {
      key: 'jiefu', name: '劫富济贫', deck: 'chance', image: '/assets/cards/jihui/jiefu.jpg',
      desc: '顺时针距你最近的玩家中，积分高者支付积分低者500积分。',
    },
    {
      key: 'qizong', name: '器宗', deck: 'chance', image: '/assets/cards/jihui/qizong.jpg',
      desc: '掷骰子，奇数积分+200，偶数积分-200。',
    },
    {
      key: 'duilian', name: '对练', deck: 'chance', image: '/assets/cards/jihui/duilian.jpg',
      desc: '若离你最近的玩家是云水母，你积分-500（不对云水母生效）；否则积分+500。',
    },
    {
      key: 'tuisai', name: '战略退赛', deck: 'chance', image: '/assets/cards/jihui/tuisai.jpg',
      desc: '支付200积分，并自行决定6及以内前进步数。',
    },
    {
      key: 'chouqian', name: '抽签嘉宾', deck: 'chance', image: '/assets/cards/jihui/chouqian.jpg',
      desc: '指定另一名玩家掷骰子，点数≥4该玩家+200，否则该玩家-200。',
    },
    {
      key: 'meiyou', name: '没有陪练', deck: 'chance', image: '/assets/cards/jihui/meiyou.jpg',
      desc: '若前后三步内有其他玩家，双方各+150；否则你-100。',
    },
    {
      key: 'michelin', name: '米其林', deck: 'chance', image: '/assets/cards/jihui/michelin.jpg', persistent: true,
      desc: '之后每到达一处地点积分+20；到达金奈时此卡不再生效。',
    },
    {
      key: 'ganfeiji', name: '赶飞机', deck: 'chance', image: '/assets/cards/jihui/ganfeiji.jpg',
      desc: '掷骰子，点数≥3积分+200，否则积分-200。',
    },
  ],
  fate: [
    {
      key: 'toubaiwa', name: '偷白袜', deck: 'fate', image: '/assets/cards/mingyun/toubaiwa.jpg',
      desc: '积分-200（仅对男性角色生效）。',
    },
    {
      key: 'fanancai', name: '发难财', deck: 'fate', image: '/assets/cards/mingyun/fanancai.jpg',
      desc: '掷骰子，点数≥5时积分+1000。',
    },
    {
      key: 'dazuoqian', name: '大做签', deck: 'fate', image: '/assets/cards/mingyun/dazuoqian.jpg',
      desc: '持有积分≥4000时-250，否则-500；张本智鳐无条件-500。',
    },
    {
      key: 'youzou', name: '游走', deck: 'fate', image: '/assets/cards/mingyun/youzou.jpg',
      desc: '当前积分≤2500时不变，否则积分-500。',
    },
    {
      key: 'baozhong', name: '爆种', deck: 'fate', image: '/assets/cards/mingyun/baozhong.jpg',
      desc: '积分+1000。',
    },
    {
      key: 'jianmianhui', name: '球员见面会', deck: 'fate', image: '/assets/cards/mingyun/jianmianhui.jpg',
      desc: '积分-200。',
    },
    {
      key: 'jifenshixiao', name: '积分失效', deck: 'fate', image: '/assets/cards/mingyun/jifenshixiao.jpg',
      desc: '失去你持有的、离你所在地最近的一站奖杯。',
    },
    {
      key: 'zushuangda', name: '组双打', deck: 'fate', image: '/assets/cards/mingyun/zushuangda.jpg',
      desc: '指定另一名玩家一起掷骰子，点数相同双方各+500。',
    },
    {
      key: 'chudifantan', name: '触底反弹', deck: 'fate', image: '/assets/cards/mingyun/chudifantan.jpg',
      desc: '当前积分≤2000时，积分+500。',
    },
    {
      key: 'caifang', name: '采访', deck: 'fate', image: '/assets/cards/mingyun/caifang.jpg',
      desc: '若你持有奖杯的赛事地官方语言为英语或你的母语，积分+200。',
    },
  ],
  item: [
    {
      key: 'jiahuo', name: '嫁祸', deck: 'item', image: '/assets/cards/daoju/jiahuo.jpg', persistent: true,
      desc: '下一次需要支付积分时，可指定一人替你支付。',
    },
    {
      key: 'jipiao', name: '机票', deck: 'item', image: '/assets/cards/daoju/jipiao.jpg',
      desc: '和任意一人互换位置，互换后双方所在地点效果皆会生效。',
    },
    {
      key: 'xieyao', name: '泻药', deck: 'item', image: '/assets/cards/daoju/xieyao.jpg',
      desc: '指定一名玩家，令其积分-500。',
    },
    {
      key: 'fanshen', name: '翻身', deck: 'item', image: '/assets/cards/daoju/fanshen.jpg',
      desc: '到达他人持有奖杯的赛事地时，令奖杯持有者支付你本应支付的积分。',
    },
    {
      key: 'qingshen', name: '请神', deck: 'item', image: '/assets/cards/daoju/qingshen.jpg',
      desc: '若你持有所处赛事地的奖杯，获得对应积分。',
    },
    {
      key: 'dunwu', name: '顿悟', deck: 'item', image: '/assets/cards/daoju/dunwu.jpg',
      desc: '免除一次积分扣除。',
    },
  ],
};

const CARD_BY_KEY = Object.fromEntries(
  Object.values(CARDS).flat().map((card) => [card.key, card])
);

const PERSISTENT = {
  pingshu: { key: 'pingshu', name: '乒超', image: '/assets/cards/jihui/pingshu.jpg' },
  michelin: { key: 'michelin', name: '米其林', image: '/assets/cards/jihui/michelin.jpg' },
  jiahuo: { key: 'jiahuo', name: '嫁祸', image: '/assets/cards/daoju/jiahuo.jpg' },
};

module.exports = {
  CHARACTERS,
  TILES,
  CARDS,
  CARD_BY_KEY,
  PERSISTENT,
  BOARD_SIZE: TILES.length,
  INITIAL_POINTS: 2000,
  MAX_PLAYERS: 8,
};
