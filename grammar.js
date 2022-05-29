// keyword extraction was not working well with instruction_name, so i just removed it. URSL compilation isn't that performance sensitive anyways
// These are at the top because they're reused as terminal symbols
// \d shouldn't be allowed as the first char to disambiguate .0 from labels and fixed/floating point in the future (if that is ever added to URCL, URSL will have equivalents)
const IDENT = /([A-Za-z_]\d*)+/;
const INDEX = /([1-9]0*)+|0/;

const i = (f) => $ => seq(optional(field("label", $.inst_label)), f($));

const inst_convert = (insts) => Object.fromEntries(Object.entries(insts).map(([opcode, operand]) => [
    opcode, i($ => operand == null ? opcode : seq(opcode, field("operand", operand($))))
]));
const headers_convert = (headers) => Object.entries(headers).map(([header, value]) => $ => seq(header, field(header, value($))));

const instructions = inst_convert({
    height: $ => $.number,
    jump: $ => $.inst_label,
    halt: null,

    perm: $ => $.permutation,
    const: $ => $._literal,

    in: $ => $.port,
    out: $ => $.port,

    call: $ => $.function_name,
    icall: $ => $.stack_behaviour,
    ret: null,

    ref: $ => $.number,
    get: $ => $.number,
    set: $ => $.number,
});

const headers = headers_convert({
    bits: $ => $.number,
    minstack: $ => $.number,
    minheap: $ => $.number,
});

// https://stackoverflow.com/a/20871714
const permutations = (inputArr) => {
    let result = [];

    const permute = (arr, m = []) => {
        if (arr.length === 0) {
            result.push(m)
        } else {
            for (let i = 0; i < arr.length; i++) {
                let curr = arr.slice();
                let next = curr.splice(i, 1);
                permute(curr.slice(), m.concat(next))
            }
        }
    }

    permute(inputArr)

    return result;
}

module.exports = grammar({
    name: "URSL",
    extras: $ => [/\s+/, $.comment],

    rules: {
        source_file: $ => seq(
            field("headers", $.headers),
            field("data", repeat($.definition)),
            field("code", repeat(choice($.func, $.inst, $.inst_permutation))),
        ),
        headers: $ => choice(
            ...permutations(headers).map(headers => seq(...headers.map(h => h($)))),
        ),
        // These can really have whatever since they are erased in compilation and do not correspond to emitted labels
        // I allow dots because i like it, and it's useful to represent compiler-generated variations of instructions
        identifier: $ => /([A-Za-z_][\d\.]*)+/,

        comment: $ => choice(
            // these weren't working properly, so i copied the ones from C# grammar.1
            // i think they're written this weirdly because of LR parsing limitations
            // (no backtracking ever, so the regex has to make sure it can't consume past the */, or else it'd never ever match and produces error nodes)
            seq("//", /[^\r\n]*/),
            seq("/*", /[^*]*\*+([^/*][^*]*\*+)*/, "/"),
        ),

        // Cannot start with a digit like if it had \w+, because it would be ambiguous with regs for URCL blocks (how did tree-sitter not catch that?)
        function_name: $ => token(seq("$", IDENT)),

        array: $ => seq("[", field("items", repeat($._literal)), "]"),
        _literal: $ => choice($.number, $.char_literal, $.macro, $.mem, $.data_label, $.function_name),

        number: $ => choice(
            /0b[0-1]+/,
            /0o[0-7]+/,
            /\d+/,
            /0x[A-Fa-f\d]+/,
        ),

        char_literal: $ => seq(
            "'",
            field("value", choice($.char, $.char_escape)),
            "'",
        ),
        char: $ => /[^\\'\r\n]/,
        char_escape: $ => /\\['\\nrt0]/,

        macro: $ => token(seq("@", IDENT)),
        mem: $ => token(seq("#", INDEX)),
        port: $ => token(seq("%", IDENT)),

        inst_label: $ => token(seq(":", IDENT)),
        data_label: $ => token(seq(".", IDENT)),
        definition: $ => seq(
            field("label", $.data_label),
            field("value", choice($._literal, $.array)),
        ),

        stack_behaviour: $ => seq(
            field("params", $.number),
            "->",
            field("returns", $.number),
        ),
        func: $ => seq(
            "func",
            field("name", $.function_name),
            optional(field("stack", $.stack_behaviour)),
            optional(seq(
                "+",
                field("locals", $.number)
            )),
            "{",
            field("instructions", repeat($._instruction)),
            "}",
        ),
        inst: $ => seq(
            "inst",
            field("name", $.identifier),
            optional(field("stack", $.stack_behaviour)),
            "{",
            field("instructions", repeat($._urcl_instruction)),
            "}",
            optional(field("branch", $.branch_block))
        ),
        inst_permutation: $ => seq(
            "inst",
            field("name", $.identifier),
            field("permutation", $.permutation),
        ),
        permutation: $ => seq(
            field("input", $.stack_frame),
            "->",
            field("output", $.stack_frame),
        ),
        stack_frame: $ => seq(
            "[",
            field("items", repeat($.identifier)),
            "]",
        ),
        branch_block: $ => seq(
            "branch",
            field("label", $.inst_label),
            "{",
            field("instructions", repeat($._urcl_instruction)),
            "}",
        ),
        _instruction: $ => choice(
            ...Object.keys(instructions).map(op => $[op]),
            $.branch,
            $.custom_instruction
        ),

        ...instructions,

        branch: i($ => seq(field("opcode", $.identifier), "branch", field("operand", $.inst_label))),
        custom_instruction: i($ => seq(field("opcode", $.identifier))),

        _urcl_instruction: $ => choice(
            $.jmp,
            $.urcl_in,
            $.urcl_out,
            $.urcl_instruction,
        ),

        register: $ => token(seq("$", INDEX)),

        _value: $ => choice($.register, $._literal),

        unary_source: $ => $.register,
        binary_source: $ => seq(
            field("src1", $.register),
            field("src2", $.register),
        ),

        jmp: $ => seq(
            optional(field("label", $.inst_label)),
            "JMP",
            field("dest", $.inst_label),
        ),

        urcl_in: $ => seq(
            optional(field("label", $.inst_label)),
            "IN",
            field("dest", $.register),
            field("source", $.port),
        ),

        urcl_out: $ => seq(
            optional(field("label", $.inst_label)),
            "OUT",
            field("dest", $.port),
            field("source", $._value),
        ),

        urcl_instruction: $ => seq(
            optional(field("label", $.inst_label)),
            field("op", $.identifier), // no validation is performed on URCL instruction names so allowing extra stuff (.) in the grammar is not an issue
            field("dest", choice($.register, $.inst_label)),
            field("source", choice(
                $._value,
                seq($._value, $._value),
            )),
        ),
    },
})