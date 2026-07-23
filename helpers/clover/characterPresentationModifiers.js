'use strict';

const {
    cleanText,
    list,
    normalizedKey,
    numberValue,
    record,
    sourceLabel,
    textList,
    uniqueBy,
} = require('./characterPresentationCore');

function effectObject(raw, fallbackSource = null) {
    if (typeof raw === 'string' || typeof raw === 'number') {
        const effect = cleanText(raw);
        return effect ? { label: null, effect, source: fallbackSource, expiresAt: null } : null;
    }
    const item = record(raw);
    const effect = cleanText(
        item.effect
        ?? item.efeito
        ?? item.description
        ?? item.descricao
        ?? item.value
        ?? item.valor
        ?? item.label
        ?? item.name
        ?? item.nome
    );
    if (!effect) return null;
    return {
        label: cleanText(item.name ?? item.nome ?? item.label),
        effect,
        source: sourceLabel(item.source ?? item.fonte ?? item.origem, fallbackSource),
        expiresAt: cleanText(item.expiresAt ?? item.expires_at),
    };
}

function withSource(entry, source) {
    return entry ? { ...entry, source } : entry;
}

function entryType(raw) {
    return normalizedKey(record(raw).type ?? record(raw).tipo ?? record(raw).category ?? record(raw).categoria);
}

function entryText(entry) {
    return normalizedKey(`${entry?.label || ''} ${entry?.effect || ''}`);
}

function isPolicyNotice(text) {
    const normalized = normalizedKey(text);
    return (
        normalized.includes('nao entram automaticamente nos numeros')
        || normalized.includes('descontos de arvore entram automaticamente')
        || normalized.includes('nao representa mana gasta')
        || normalized.includes('aviso do sistema')
        || normalized.includes('regra do sistema')
    );
}

function isRecurringEntry(entry, raw = null) {
    const type = entryType(raw);
    const text = entryText(entry);
    const recurringType = [
        'salario', 'renda', 'pagamento', 'beneficio recorrente', 'economico', 'economia recorrente',
    ].some((pattern) => type.includes(pattern));
    const recurringText = [
        'salario semanal', 'salario mensal', 'salario diario',
        'renda semanal', 'renda mensal', 'renda diaria',
        'pagamento semanal', 'pagamento mensal', 'pagamento diario',
        'recebe semanalmente', 'recebe mensalmente', 'recebe diariamente',
    ].some((pattern) => text.includes(pattern));
    return recurringType || recurringText;
}

function isNarrativeEntry(entry, raw = null) {
    const type = entryType(raw);
    const text = entryText(entry);
    return (
        type.includes('narrativ')
        || type.includes('afinidade')
        || text.includes('afinidade narrativa')
        || text.includes('vantagem narrativa')
        || text.includes('aptidao narrativa')
    );
}

function isPenaltyEntry(entry, raw = null) {
    const type = entryType(raw);
    const text = entryText(entry);
    const beneficialReduction = [
        'gasto de mana',
        'custo de mana',
        'consumo de mana',
        'tempo de recarga',
        'custo de ph',
        'preco de compra',
    ].some((pattern) => text.includes(pattern));
    return (
        type.includes('penalidade')
        || type.includes('debuff')
        || text.includes('penalidade')
        || text.includes('reducao de atributo')
        || (!beneficialReduction && /(^|\s)-\d+(?:[.,]\d+)?%/.test(String(entry?.effect || '')))
    );
}

function parseDiscountPercent(value) {
    const direct = numberValue(record(value).percent, record(value).porcentagem);
    if (direct !== null) return direct;
    const text = cleanText(record(value).effect ?? record(value).efeito ?? record(value).label ?? value);
    if (!text) return null;
    const match = text.match(/(\d+(?:[.,]\d+)?)\s*%/);
    return match ? Number(match[1].replace(',', '.')) : null;
}

function presentDiscount(raw, fallbackSource = 'Árvore') {
    const item = record(raw);
    const percent = parseDiscountPercent(raw);
    if (percent === null || percent <= 0) return null;
    const sources = textList(item.sources ?? item.fontes);
    const rawText = cleanText(
        item.effect
        ?? item.efeito
        ?? item.description
        ?? item.descricao
        ?? (typeof raw === 'string' || typeof raw === 'number' ? raw : null)
    );
    const textLabelMatch = rawText?.match(
        /desconto(?:\s+autom[aá]tico)?\s+em\s+(.+?):\s*\d+(?:[.,]\d+)?\s*%/i
    );
    const label = cleanText(
        item.label
        ?? item.name
        ?? item.nome
        ?? item.treeLabel
        ?? item.treeId
        ?? textLabelMatch?.[1]
    ) || 'Desconto de árvore';
    return {
        label,
        effect: `${percent}%`,
        source: sources.length ? sources.join(' + ') : sourceLabel(item.source, fallbackSource),
        expiresAt: null,
    };
}

function presentModifiers(bonusInput, traitOverviewInput) {
    const bonus = record(bonusInput);
    const overview = record(traitOverviewInput);
    const automatic = [];
    const conditional = [];
    const recurring = [];
    const narrative = [];
    const penalties = [];
    const discounts = [];
    const notices = [];

    const pushEffect = (target, raw, fallbackSource) => {
        const entry = effectObject(raw, fallbackSource);
        if (entry) target.push(entry);
    };

    const classifyManual = (raw, fallbackSource = 'Bônus condicionado') => {
        const entry = effectObject(raw, fallbackSource);
        if (!entry) return;
        if (isPolicyNotice(entry.effect)) notices.push(withSource(entry, 'Regra do sistema'));
        else if (isRecurringEntry(entry, raw)) recurring.push(withSource(entry, 'Benefício recorrente'));
        else if (isNarrativeEntry(entry, raw)) narrative.push(withSource(entry, 'Afinidade narrativa'));
        else if (isPenaltyEntry(entry, raw)) penalties.push(entry);
        else conditional.push(entry);
    };

    list(bonus.automatic ?? bonus.automaticos).forEach((raw) => {
        const discount = normalizedKey(record(raw).effect ?? record(raw).efeito ?? raw).includes('desconto')
            ? presentDiscount(raw)
            : null;
        if (discount) discounts.push(discount);
        else pushEffect(automatic, raw, 'Bônus automático');
    });

    list(bonus.notAutomatic ?? bonus.nao_automaticos).forEach((raw) => classifyManual(raw));

    const treeDiscounts = bonus.treeDiscounts ?? bonus.descontos_arvore ?? bonus.descontos_arvore_lista;
    const structuredDiscounts = Array.isArray(treeDiscounts)
        ? treeDiscounts
        : Object.values(record(treeDiscounts));
    structuredDiscounts.forEach((raw) => {
        const discount = presentDiscount(raw);
        if (discount) discounts.push(discount);
    });

    list(bonus.customBonuses).forEach((raw) => {
        const entry = effectObject(raw, cleanText(record(raw).source) || 'Bônus personalizado');
        if (!entry) return;
        if (record(raw).automatic === true) automatic.push(entry);
        else if (isRecurringEntry(entry, raw)) recurring.push(withSource(entry, 'Benefício recorrente'));
        else if (isNarrativeEntry(entry, raw)) narrative.push(withSource(entry, 'Afinidade narrativa'));
        else if (isPenaltyEntry(entry, raw)) penalties.push(entry);
        else conditional.push(entry);
    });

    list(overview.bonuses).forEach((raw) => {
        const entry = effectObject(raw, cleanText(record(raw).source) || 'Registro administrativo');
        if (!entry) return;
        if (normalizedKey(record(raw).type).includes('automatic')) automatic.push(entry);
        else if (isRecurringEntry(entry, raw)) recurring.push(withSource(entry, 'Benefício recorrente'));
        else if (isNarrativeEntry(entry, raw)) narrative.push(withSource(entry, 'Afinidade narrativa'));
        else if (isPenaltyEntry(entry, raw)) penalties.push(entry);
        else conditional.push(entry);
    });

    list(bonus.warnings ?? bonus.avisos).forEach((raw) => {
        const entry = effectObject(raw, 'Regra do sistema');
        if (entry) notices.push(withSource(entry, 'Regra do sistema'));
    });

    const dedupe = (items) => uniqueBy(
        items,
        (item) => normalizedKey(`${item.label || ''}:${item.effect}:${item.source || ''}`)
    );
    const discountMap = new Map();
    for (const discount of discounts) {
        const key = normalizedKey(`${discount.label || ''}:${discount.effect}`);
        if (!key) continue;
        const current = discountMap.get(key);
        const currentGeneric = !current?.source || normalizedKey(current.source) === 'arvore';
        const nextSpecific = discount.source && normalizedKey(discount.source) !== 'arvore';
        if (!current || (currentGeneric && nextSpecific)) discountMap.set(key, discount);
    }

    return {
        automatic: dedupe(automatic),
        conditional: dedupe(conditional),
        recurring: dedupe(recurring),
        narrative: dedupe(narrative),
        penalties: dedupe(penalties),
        discounts: [...discountMap.values()],
        notices: dedupe(notices),
    };
}

module.exports = {
    presentModifiers,
};