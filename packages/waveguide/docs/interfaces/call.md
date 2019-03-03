[waveguide](../README.md) > [Call](../interfaces/call.md)

# Interface: Call

## Hierarchy

**Call**

## Implemented by

* [ChainFrame](../classes/chainframe.md)
* [ErrorFrame](../classes/errorframe.md)
* [FinalizeFrame](../classes/finalizeframe.md)
* [InterruptFrame](../classes/interruptframe.md)

## Index

### Methods

* [apply](call.md#apply)

---

## Methods

<a id="apply"></a>

###  apply

▸ **apply**(a: *`unknown`*): [IO](../classes/io.md)<`unknown`, `unknown`>

*Defined in [runtime.ts:14](https://github.com/rzeigler/waveguide/blob/79b3787/packages/waveguide/src/runtime.ts#L14)*

Encodes the normal invocation of the call stack where a value is received and the continuation must be processed

**Parameters:**

| Name | Type |
| ------ | ------ |
| a | `unknown` |

**Returns:** [IO](../classes/io.md)<`unknown`, `unknown`>

___
