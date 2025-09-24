export function getJurisdiction(letter: string) {
    switch (letter) {
        case 'BR':
            return 'Brasil';
        case 'PT':
            return 'Portugal';
        case 'ES':
            return 'Espanha';
    }
}

export function getJurisdictionLanguage(letter: string) {
    switch (letter) {
        case 'BR':
            return 'Português brasileiro (pt-BR)';
        case 'PT':
            return 'Português europeu (pt-PT)';
        case 'ES':
            return 'Espanhol (es-ES)';
    }
}