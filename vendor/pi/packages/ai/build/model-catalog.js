export function flattenModelCatalog(_provider, groups) {
    return Object.assign({}, ...Object.values(groups));
}
